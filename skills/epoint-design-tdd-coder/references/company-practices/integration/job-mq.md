# Job 与 MQ 写法示例

用于定时同步、补偿任务、RabbitMQ 消费/发送。注册调度或 listener 配置前必须确认 cron、队列、exchange、routing key、ack 策略。

## Quartz Job

```java
import org.quartz.DisallowConcurrentExecution;
import org.quartz.Job;
import org.quartz.JobExecutionContext;
import org.quartz.JobExecutionException;
import org.slf4j.Logger;

import com.epoint.core.utils.container.ContainerFactory;
import com.epoint.core.utils.log.LogUtil;

@DisallowConcurrentExecution
public class XxxSyncJob implements Job {
    private final Logger logger = LogUtil.getSLF4JLog(XxxSyncJob.class);

    private IXxxSyncService service;

    public XxxSyncJob() {
        service = ContainerFactory.getContainInfo().getComponent(IXxxSyncService.class);
    }

    @Override
    public void execute(JobExecutionContext context) throws JobExecutionException {
        long start = System.currentTimeMillis();
        String batchId = "sync-" + java.util.UUID.randomUUID().toString().substring(0, 8);
        org.slf4j.MDC.put("batchId", batchId);
        try {
            logger.info("[xxx-sync] batch start batchId={}", batchId);
            int count = service.syncOnce();
            logger.info("[xxx-sync] batch done batchId={} count={} elapsed={}ms",
                    batchId, count, System.currentTimeMillis() - start);
        }
        catch (Throwable t) {
            logger.error("[xxx-sync] batch failed batchId={} elapsed={}ms",
                    batchId, System.currentTimeMillis() - start, t);
            throw new JobExecutionException(t);
        }
        finally {
            org.slf4j.MDC.remove("batchId");
        }
    }
}
```

要点：

- `@DisallowConcurrentExecution` 避免并发执行。
- Job 内获取服务常用 `ContainerFactory.getContainInfo().getComponent(IService.class)`。
- Job 只做调度入口、日志、异常包装和调用 Service；统计、查询、写库、外部接口编排必须下沉到 Service。
- Job 内禁止 `CommonDao`、`ICommonDao`、`baseDao`、`commonDao`、`String sql` 和直接 DAO 调用。
- DAO 方法必须来自 `ICommonDao使用规范` 或工作包列出的精确源码；禁止凭印象写 `queryMapList`、`query`、`count` 等方法。

Service 中再写数据访问：

```java
public class XxxSyncService {
    protected ICommonDao baseDao;

    public XxxSyncService() {
        baseDao = CommonDao.getInstance();
    }

    public int syncOnce() {
        String sql = "select rowguid, name from xxx_source where status = ?";
        List<XxxInfo> list = baseDao.findList(sql, XxxInfo.class, "1");
        // 业务处理、幂等、入库都在 Service 内完成
        return list.size();
    }
}
```

## quartz_data.xml

只有用户明确要求注册定时调度并确认 cron 后才追加：

```xml
<schedule>
    <job>
        <name>XxxSyncJob</name>
        <group>xxxsync</group>
        <job-class>com.epoint.xxx.job.XxxSyncJob</job-class>
    </job>
    <trigger>
        <cron>
            <name>XxxSyncTrigger</name>
            <group>xxxsync</group>
            <job-name>XxxSyncJob</job-name>
            <job-group>xxxsync</job-group>
            <cron-expression>0 0 2 * * ?</cron-expression>
        </cron>
    </trigger>
</schedule>
```

要点：

- 只能按本项目 `quartz_data.xml` 已有结构追加，不重排全文件。
- 确认 `name/group/job-class/cron-expression`，避免重复注册。

## MQ Listener

```java
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.core.ChannelAwareMessageListener;

import com.alibaba.fastjson.JSONObject;
import com.epoint.core.utils.container.ContainerFactory;
import com.epoint.core.utils.string.StringUtil;
import com.rabbitmq.client.Channel;

public class XxxMessageListener implements ChannelAwareMessageListener {

    @Override
    public void onMessage(Message message, Channel channel) throws Exception {
        String msg = new String(message.getBody(), "UTF-8");
        if (StringUtil.isBlank(msg)) {
            return;
        }

        JSONObject jsonObject = JSONObject.parseObject(msg);
        IXxxMessageService service = ContainerFactory.getContainInfo().getComponent(IXxxMessageService.class);
        service.handleMessage(jsonObject);
    }
}
```

带手动 ack/nack 的项目必须照现有 listener 写，不要自己决定：

```java
finally {
    channel.basicNack(message.getMessageProperties().getDeliveryTag(), false, false);
}
```

要点：

- 常见接口：`ChannelAwareMessageListener`、`Message`、`Channel`、`JSONObject.parseObject`。
- 幂等键、重试策略、失败是否 ack/nack 必须按业务和项目样例确认。
- 不要在 listener 里写大段业务流程，落到 Service。

## appcontext-rabbitmq.xml

```xml
<rabbit:queue name="queue_xxx" durable="true"
    auto-delete="false" exclusive="false" />

<bean id="xxxMessageListener"
    class="com.epoint.xxx.mq.XxxMessageListener" />

<rabbit:listener-container
    connection-factory="connectionFactory" acknowledge="manual">
    <rabbit:listener queue-names="queue_xxx"
        ref="xxxMessageListener" />
</rabbit:listener-container>
```

主题交换机绑定：

```xml
<rabbit:topic-exchange name="exchange_xxx"
    id="exchange_xxx" durable="true" auto-delete="true">
    <rabbit:bindings>
        <rabbit:binding queue="queue_xxx"
            pattern="xxx.*" />
    </rabbit:bindings>
</rabbit:topic-exchange>
```

要点：

- `acknowledge="auto"` 还是 `manual` 必须看本项目同容器配置。
- `rabbitmq.properties` 只读连接信息，不输出 host/user/password。
- 只能按本项目 `spring/appcontext-rabbitmq.xml` 已有结构追加。
