const db = require('./db');
const ws = require('./websocket-client');
const uuid = require('uuid');
const wsClient = new ws.Client();

const success = {
  statusCode: 200
};

async function connectionManager(event, context) {
  await wsClient._setupClient(event);

  if (event.requestContext.eventType === "CONNECT") {

    // await subscribeChannel(
    //   {
    //     ...event,
    //     body: JSON.stringify({
    //       action: "subscribe",
    //       channelId: "General"
    //     })
    //   },
    //   context
    // );

    return success;
  } else if (event.requestContext.eventType === "DISCONNECT") {
    // unsub all channels connection was in
    const subscriptions =await db.fetchConnectionSubscriptions(event);
    const unsubscribes = subscriptions.map(async subscription =>
      // just simulate / reuse the same as if they issued the request via the protocol
      unsubscribeChannel(
        {
          ...event,
          body: JSON.stringify({
            action: "unsubscribe",
            channelId: db.parseEntityId(subscription[db.Channel.Primary.Key])
          })
        },
        context
      )
    );
    await Promise.all(unsubscribes);
    return success;
  }
}

async function defaultMessage(event, context) {
  await wsClient.send(event, {
    event: "error",
    message: "invalid action type"
  });
  return success;
}

async function sendMessage(event, context) {
  const body = JSON.parse(event.body);
  const messageId = `${db.Message.Prefix}${Date.now()}`;
  const eventTitle = body.eventTitle;
  const content = body.content;
  const eventId = uuid.v4();

  const item = await db.Client.put({
    TableName: db.Table,
    Item: {
      [db.Message.Primary.Key]: `${db.Channel.Prefix}${body.channelId}`,
      [db.Message.Primary.Range]: messageId,
      ConnectionId: `${event.requestContext.connectionId}`,
      eventTitle: eventTitle,
      Content: content,
      timestamp: Date.now()
    }
  }).promise();

  await db.Client.put({
    TableName: db.clientEventsTable,
    Item: {
      id: eventId,
      clientId: body.channelId,
      eventTitle: eventTitle,
      content: content,
      timestamp: Date.now()
    }
  }).promise();

  const subscribers = await db.fetchChannelSubscriptions(body.channelId);
  const results = subscribers.map(async subscriber => {
    const subscriberId = db.parseEntityId(
      subscriber[db.Channel.Connections.Range]
    );
    return wsClient.send(subscriberId, {
      event: "channel_message",
      id: eventId,
      channelId: body.channelId,
      eventTitle,
      content,
      timestamp: new Date()
    });
  });

  await Promise.all(results);
  return success;
}

async function broadcast(event, context) {
  const results = event.Records.map(async record => {
    switch (record.dynamodb.Keys[db.Primary.Key].S.split("|")[0]) {
      case db.Connection.Entity:
        break;

      case db.Channel.Entity:
        switch (record.dynamodb.Keys[db.Primary.Range].S.split("|")[0]) {
          // if we are a CONNECTION
          case db.Connection.Entity: {
            let eventType = "sub";
            if (record.eventName === "REMOVE") {
              eventType = "unsub";
            } else if (record.eventName === "UPDATE") {
              break;
            }

            const channelId = db.parseEntityId(
              record.dynamodb.Keys[db.Primary.Key].S
            );
            const subscribers = await db.fetchChannelSubscriptions(channelId);
            const results = subscribers.map(async subscriber => {
              const subscriberId = db.parseEntityId(
                subscriber[db.Channel.Connections.Range]
              );
              return wsClient.send(
                subscriberId, // really backwards way of getting connection id
                {
                  event: `subscriber_${eventType}`,
                  channelId,
                  subscriberId: db.parseEntityId(
                    record.dynamodb.Keys[db.Primary.Range].S
                  )
                }
              );
            });

            await Promise.all(results);
            break;
          }

          // If we are a MESSAGE
          case db.Message.Entity: {
            if (record.eventName !== "INSERT") {
              return success;
            }
            break;
          }
          default:
            break;
        }

        break;
      default:
        break;
    }
  });

  await Promise.all(results);
  return success;
}

async function channelManager(event, context) {
  const action = JSON.parse(event.body).action;
  switch (action) {
    case "subscribeChannel":
      await subscribeChannel(event, context);
      break;
    case "unsubscribeChannel":
      await unsubscribeChannel(event, context);
      break;
    default:
      break;
  }
  return success;
}

async function subscribeChannel(event, context) {
  const channelId = JSON.parse(event.body).channelId;
  await db.Client.put({
    TableName: db.Table,
    Item: {
      [db.Channel.Connections.Key]: `${db.Channel.Prefix}${channelId}`,
      [db.Channel.Connections.Range]: `${db.Connection.Prefix}${
        db.parseEntityId(event)
      }`
    }
  }).promise();
  return success;
}

async function unsubscribeChannel(event, context) {
  const channelId = JSON.parse(event.body).channelId;
  const item = await db.Client.delete({
    TableName: db.Table,
    Key: {
      [db.Channel.Connections.Key]: `${db.Channel.Prefix}${channelId}`,
      [db.Channel.Connections.Range]: `${db.Connection.Prefix}${
        db.parseEntityId(event)
      }`
    }
  }).promise();
  return success;
}

module.exports = {
  connectionManager,
  defaultMessage,
  sendMessage,
  broadcast,
  subscribeChannel,
  unsubscribeChannel,
  channelManager
};