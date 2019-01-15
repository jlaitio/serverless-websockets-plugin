const { is, map, all, filter, keys, isEmpty, flatten, equals, get } = require('@serverless/utils')
const chalk = require('chalk')

class ServerlessWebsocketsPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.provider = this.serverless.getProvider('aws')

    // to be filled later...
    this.allFunctions = []
    this.websocketFunctions = []

    this.hooks = {
      'after:deploy:deploy': this.deployWebsockets.bind(this), // todo change
      'after:remove:remove': this.removeWebsockets.bind(this),
      'after:info:info': this.displayWebsockets.bind(this)
    }
  }

  getWebsocketApiName() {
    if (
      this.serverless.service.provider.websocketApiName &&
      is(String, this.serverless.service.provider.websocketApiName)
    ) {
      return `${this.serverless.service.provider.websocketApiName}`
    }
    return `${this.serverless.service.service}-${this.provider.getStage()}-websockets-api`
  }

  getWebsocketApiRouteSelectionExpression() {
    if (
      this.serverless.service.provider.websocketApiRouteSelectionExpression &&
      is(String, this.serverless.service.provider.websocketApiRouteSelectionExpression)
    ) {
      return `${this.serverless.service.provider.websocketApiRouteSelectionExpression}`
    }
    return `$request.body.action`
  }

  getWebsocketUrl() {
    return `wss://${this.apiId}.execute-api.${this.region}.amazonaws.com/${this.stage}/`
  }

  init() {
    this.apiName = this.getWebsocketApiName()
    this.routeSelectionExpression = this.getWebsocketApiRouteSelectionExpression()
    this.stage = this.provider.getStage()
    this.region = this.provider.getRegion()
  }

  async deployWebsockets() {
    this.init()
    await this.prepareFunctions()
    if (
      !is(Object, this.serverless.service.functions) ||
      keys(this.serverless.service.functions).length === 0 ||
      isEmpty(this.websocketFunctions)
    ) {
      return
    }
    this.serverless.cli.log(`Deploying Websockets API named "${this.apiName}"...`)
    await this.createApi()
    await this.createRoutes()
    await this.createDeployment()
    this.serverless.cli.log(
      `Websockets API named "${this.apiName}" with ID "${this.apiId}" has been deployed.`
    )
    this.serverless.cli.log(`  Websocket URL: ${this.getWebsocketUrl()}`)
  }

  async prepareFunctions() {
    // get a list of CF outputs...
    const res = await this.provider.request('CloudFormation', 'describeStacks', {
      StackName: this.provider.naming.getStackName()
    })
    const outputs = res.Stacks[0].Outputs

    this.allFunctions = keys(this.serverless.service.functions || {}).map((name) => {
      const func = this.serverless.service.functions[name]

      // find the arn of this function in the list of outputs...
      const outputKey = this.provider.naming.getLambdaVersionOutputLogicalId(name)
      const arn = outputs.find((output) => output.OutputKey === outputKey).OutputValue

      // get list of routes configured for this function
      const routes = map(
        (e) => e.websocket,
        filter((e) => e.websocket && e.websocket.routeKey, func.events || [])
      )

      return {
        name,
        arn,
        routes
      }
    })
    this.websocketFunctions = this.allFunctions.filter((fn) => !isEmpty(fn.routes))
  }

  async getApi() {
    const apis = await this.provider.request('ApiGatewayV2', 'getApis', {})
    // todo what if existing api is not valid websocket api? or non existent?
    const websocketApi = apis.Items.find((api) => api.Name === this.apiName)
    this.apiId = websocketApi ? websocketApi.ApiId : null
    return this.apiId
  }

  async createApi() {
    await this.getApi()
    if (!this.apiId) {
      const params = {
        Name: this.apiName,
        ProtocolType: 'WEBSOCKET',
        RouteSelectionExpression: this.routeSelectionExpression
      }

      const res = await this.provider.request('ApiGatewayV2', 'createApi', params)
      this.apiId = res.ApiId
    }
    return this.apiId
  }

  async createIntegration(arn) {
    const params = {
      ApiId: this.apiId,
      IntegrationMethod: 'POST',
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: `arn:aws:apigateway:${
        this.region
      }:lambda:path/2015-03-31/functions/${arn}/invocations`
    }
    // integration creation overwrites existing identical integration
    // so we don't need to check for existance
    const res = await this.provider.request('ApiGatewayV2', 'createIntegration', params)
    return res.IntegrationId
  }

  async addPermission(arn, resource = '/*/*') {
    const functionName = arn.split(':')[6]
    const accountId = arn.split(':')[4]
    const region = arn.split(':')[3]

    const params = {
      Action: 'lambda:InvokeFunction',
      FunctionName: arn,
      Principal: 'apigateway.amazonaws.com',
      SourceArn: `arn:aws:execute-api:${region}:${accountId}:${this.apiId}${resource}`,
      StatementId: `${functionName}-websocket`
    }

    return this.provider.request('Lambda', 'addPermission', params).catch((e) => {
      if (e.providerError.code !== 'ResourceConflictException') {
        throw e
      }
    })
  }

  async createRouteResponse(routeId, routeResponseKey) {
    const params = {
      ApiId: this.apiId,
      RouteId: routeId,
      RouteResponseKey: routeResponseKey
    }

    return await this.provider.request('ApiGatewayV2', 'createRouteResponse', params)
  }

  async createAuthorizer(arn, options) {
    // check if matching authorizer exists already
    const { Items } = await this.provider.request('ApiGatewayV2', 'getAuthorizers', {
      ApiId: this.apiId
    })

    const AuthorizerUri = `arn:aws:apigateway:${
      this.region
    }:lambda:path/2015-03-31/functions/${arn}/invocations`

    const existingAuthorizer = Items.find(
      (item) =>
        item.AuthorizerUri === AuthorizerUri && equals(item.IdentitySource, options.identitySources)
    )

    // if existing authorizer matches, return it
    if (existingAuthorizer) {
      return existingAuthorizer.AuthorizerId
    }

    // otherwise create a new one and return that
    const params = {
      ApiId: this.apiId,
      AuthorizerUri,
      AuthorizerType: 'REQUEST',
      IdentitySource: options.identitySources,
      Name: 'authorizer' + (Items.length + 1)
    }

    const { AuthorizerId } = await this.provider.request('ApiGatewayV2', 'createAuthorizer', params)

    await this.addPermission(arn, `/authorizers/${AuthorizerId}`)

    return AuthorizerId
  }

  async createRoute(integrationId, route) {
    const getAuthorizerId = async () => {
      if (route.routeKey === '$connect' && route.authorizer) {
        const authorizerArn =
          route.authorizer.arn ||
          get('arn', this.allFunctions.find((fn) => fn.name === route.authorizer.name))

        if (authorizerArn && route.authorizer.identitySources) {
          return await this.createAuthorizer(authorizerArn, route.authorizer)
        }
      }
    }
    const AuthorizerId = await getAuthorizerId()

    const params = {
      ApiId: this.apiId,
      RouteKey: route.routeKey,
      Target: `integrations/${integrationId}`,
      AuthorizerId,
      AuthorizationType: AuthorizerId ? 'CUSTOM' : undefined
    }
    if (route.routeResponseSelectionExpression) {
      params.RouteResponseSelectionExpression = route.routeResponseSelectionExpression
    }

    const res = await this.provider.request('ApiGatewayV2', 'createRoute', params).catch((e) => {
      if (e.providerError.code !== 'ConflictException') {
        throw e
      }
    })

    if (route.routeResponseSelectionExpression) {
      await this.createRouteResponse(res.RouteId, '$default')
    }

    return res
  }

  async clearRoutes() {
    const res = await this.provider.request('ApiGatewayV2', 'getRoutes', { ApiId: this.apiId })
    return all(
      map(
        (route) =>
          this.provider.request('ApiGatewayV2', 'deleteRoute', {
            ApiId: this.apiId,
            RouteId: route.RouteId
          }),
        res.Items
      )
    )
  }

  async createRoutes() {
    // We clear routes before deploying the new routes for idempotency
    // since we lost the idempotency feature of CF
    await this.clearRoutes()

    const integrationsPromises = map(async (fn) => {
      const integrationId = await this.createIntegration(fn.arn)
      await this.addPermission(fn.arn)
      const routesPromises = map((route) => this.createRoute(integrationId, route), fn.routes)
      return all(routesPromises)
    }, this.websocketFunctions)

    return all(integrationsPromises)
  }

  async createDeployment() {
    const { DeploymentId } = await this.provider.request('ApiGatewayV2', 'createDeployment', {
      ApiId: this.apiId
    })
    const params = {
      ApiId: this.apiId,
      StageName: this.stage,
      DeploymentId
    }

    return this.provider.request('ApiGatewayV2', 'updateStage', params).catch((e) => {
      if (e.providerError.code === 'NotFoundException') {
        return this.provider.request('ApiGatewayV2', 'createStage', params)
      }
    })
  }

  async removeWebsockets() {
    this.init()
    await this.getApi()
    if (!this.apiId) {
      return
    }

    this.serverless.cli.log(
      `Removing Websockets API named "${this.apiName}" with ID "${this.apiId}"`
    )
    return this.provider.request('ApiGatewayV2', 'deleteApi', { ApiId: this.apiId })
  }

  async displayWebsockets() {
    this.init()
    await this.prepareFunctions()
    if (isEmpty(this.websocketFunctions)) {
      return
    }
    await this.getApi()
    const baseUrl = this.getWebsocketUrl()
    const routes = flatten(map((fn) => fn.routes.routeKey, this.websocketFunctions))
    this.serverless.cli.consoleLog(chalk.yellow('WebSockets:'))
    this.serverless.cli.consoleLog(`  ${chalk.yellow('Base URL:')} ${baseUrl}`)
    this.serverless.cli.consoleLog(chalk.yellow('  Routes:'))
    map((route) => this.serverless.cli.consoleLog(`    - ${baseUrl}${route}`), routes)
  }
}

module.exports = ServerlessWebsocketsPlugin
