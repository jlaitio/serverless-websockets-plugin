# Serverless Websockets Plugin

## 1. Installation
Install the plugin by adding it to your service dependencies:
```
npm i serverless-websockets-plugin --save
```

**Note:** Because this plugin uses the new `ApiGatewayV2` service in the AWS SDK, it requires v1.35.0+ of the Serverless Framework.

## 2. Usage
Load the `serverless-websockets-plugin`, then optionally provide a new API name and Route Selection Expression, and finally define your WebSockets events and their route keys:
```yml
service: serverless-websockets-service

# Load the plugin
plugins:
  - serverless-websockets-plugin

provider:
  name: aws
  runtime: nodejs8.10
  
  # Optional
  websocketApiName: foobar
  websocketApiRouteSelectionExpression: $request.body.action

functions:
  connectionManagement:
    handler: handler.connectionManagement
    events:
      - websocket:
          routeKey: $connect
      - websocket:
          routeKey: $disconnect
  defaultMessage:
    handler: handler.default
    events:
      - websocket:
          routeKey: $default
  chatMessage:
    handler: handler.chat
    events:
      - websocket:
          routeKey: message
  twoWayMessage:
    handler: handler.twoWay
    events:
      - websocket:
          routeKey: twoway
          # The property below will enable an integration response in the API Gateway.
          # See https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-response.html
          routeResponseSelectionExpression: $default
```

### 2.1. Custom Authorizers
You can configure a custom authorizer for your websocket API. Note that only the `$connect`-route uses the authorizer, and your subsequent frames will use the context from that authorization. Authorizer configurations for other routes will be ignored. You must supply the identity source(s) of your authentication, and either a function name or ARN. If your authorizer is not in the same service, you must use the ARN. Two examples:

```yml
functions:
  authorizer:
    handler: handler.authorization
  connectionManagement:
    handler: handler.connectionManagement
    events:
      - websocket:
          routeKey: $connect
          authorizer:
            name: authorizer
            identitySources:
              - route.request.querystring.access_token
```

```yml
functions:
  connectionManagement:
    handler: handler.connectionManagement
    events:
      - websocket:
          routeKey: $connect
          authorizer:
            arn: arn:aws:myArn
            identitySources:
              - route.request.header.Authorization
```