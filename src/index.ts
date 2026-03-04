#!/usr/bin/env node

// MCP SQL Server - Production version

async function runServer() {
  try {
    // Dynamic imports to support execution from any working directory
    const { handleCliArgs } = await import('./cli.js');
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const {
      CallToolRequestSchema,
      ListToolsRequestSchema,
    } = await import('@modelcontextprotocol/sdk/types.js');
    const { SqlServerConnection } = await import('./connection.js');
    const { ConnectionConfigSchema } = await import('./types.js');
    const {
      ListDatabasesTool,
      ListTablesTool,
      ListViewsTool,
      DescribeTableTool,
      ExecuteQueryTool,
      GetForeignKeysTool,
      GetServerInfoTool,
      GetTableStatsTool,
      TestConnectionTool,
      SnapshotSchemaTool,
    } = await import('./tools/index.js');
    const { ErrorHandler } = await import('./errors.js');
    const { SchemaCache } = await import('./schema-cache.js');

    class SqlServerMCPServer {
      private server: typeof Server.prototype;
      private connection!: typeof SqlServerConnection.prototype;
      private tools: Map<string, any> = new Map();

      constructor() {
        this.server = new Server(
          {
            name: 'mcp-sqlserver',
            version: '2.0.3',
          },
          {
            capabilities: {
              tools: {},
            },
          }
        );

        this.setupErrorHandling();
        this.setupRequestHandlers();
      }

      private setupErrorHandling() {
        this.server.onerror = (error: Error) => {
          console.error('[MCP Error]', error);
        };

        process.on('SIGINT', async () => {
          await this.cleanup();
          process.exit(0);
        });

        process.on('SIGTERM', async () => {
          await this.cleanup();
          process.exit(0);
        });
      }

      private async cleanup() {
        if (this.connection) {
          await this.connection.disconnect();
        }
      }

      private setupRequestHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
          return {
            tools: Array.from(this.tools.values()).map(tool => ({
              name: tool.getName(),
              description: tool.getDescription(),
              inputSchema: tool.getInputSchema(),
            })),
          };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args } = request.params;
          
          if (!this.tools.has(name)) {
            throw new Error(`Unknown tool: ${name}`);
          }

          const tool = this.tools.get(name);
          
          try {
            const result = await tool.execute(args || {});
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleSqlServerError(error);
            const userError = ErrorHandler.formatErrorForUser(mcpError);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: userError.error,
                    code: userError.code,
                    suggestions: userError.suggestions,
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }
        });
      }

      private initializeTools(maxRows: number, schemaCache: InstanceType<typeof SchemaCache>) {
        const toolClasses = [
          TestConnectionTool,
          ListDatabasesTool,
          ListTablesTool,
          ListViewsTool,
          DescribeTableTool,
          ExecuteQueryTool,
          GetForeignKeysTool,
          GetServerInfoTool,
          GetTableStatsTool,
          SnapshotSchemaTool,
        ];

        for (const ToolClass of toolClasses) {
          const tool = new ToolClass(this.connection, maxRows);
          // Inject schema cache into tools that need it
          if ('setSchemaCache' in tool) {
            (tool as any).setSchemaCache(schemaCache);
          }
          this.tools.set(tool.getName(), tool);
        }
      }

      async initialize(config: any) {
        try {
          this.connection = new SqlServerConnection(config);
          
          // Don't connect immediately in MCP mode - defer connection until first tool use
          // This prevents the server from failing startup if SQL Server is temporarily unavailable
          console.error(`MCP SQL Server initialized for ${config.server}:${config.port || 1433}`);
          console.error(`Database: ${config.database || 'default'}, Auth: ${config.authMode || 'sql'}${config.authMode === 'sql' ? `, User: ${config.user}` : ''}`);
          console.error(`ApplicationIntent: ReadOnly`);

          // Initialize schema cache
          // Uses SQLSERVER_SCHEMA_CACHE_PATH if set, otherwise derives from database name
          const dbNameForCache = (config.database || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
          const { fileURLToPath } = await import('url');
          const { dirname: pathDirname, join: pathJoin } = await import('path');
          const serverDir = pathDirname(fileURLToPath(import.meta.url));
          const defaultCachePath = pathJoin(serverDir, '..', '.schema-cache', `${dbNameForCache}.md`);
          const schemaCachePath = process.env.SQLSERVER_SCHEMA_CACHE_PATH || defaultCachePath;
          const domainSourcePath = process.env.SQLSERVER_DOMAIN_SOURCE_PATH;
          if (domainSourcePath) {
            console.error(`Domain source: ${domainSourcePath}`);
          }
          const schemaCache = new SchemaCache(schemaCachePath, domainSourcePath);
          console.error(`Schema cache: ${schemaCachePath}`);

          this.initializeTools(config.maxRows || 1000, schemaCache);
        } catch (error) {
          console.error(`Initialization failed:`, error);
          throw error;
        }
      }

      async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('MCP SQL Server running on stdio');
      }
    }

    async function main() {
      // Handle CLI arguments and help
      if (!handleCliArgs()) {
        return;
      }

      // Read configuration from environment variables
      const authMode = (process.env.SQLSERVER_AUTH_MODE || 'sql') as 'sql' | 'aad-default' | 'aad-password' | 'aad-service-principal';
      const config = {
        server: process.env.SQLSERVER_HOST || 'localhost',
        database: process.env.SQLSERVER_DATABASE,
        authMode,
        user: process.env.SQLSERVER_USER,
        password: process.env.SQLSERVER_PASSWORD,
        clientId: process.env.SQLSERVER_CLIENT_ID,
        clientSecret: process.env.SQLSERVER_CLIENT_SECRET,
        tenantId: process.env.SQLSERVER_TENANT_ID,
        port: parseInt(process.env.SQLSERVER_PORT || '1433'),
        encrypt: process.env.SQLSERVER_ENCRYPT !== 'false',
        trustServerCertificate: process.env.SQLSERVER_TRUST_CERT !== 'false',
        connectionTimeout: parseInt(process.env.SQLSERVER_CONNECTION_TIMEOUT || '30000'),
        requestTimeout: parseInt(process.env.SQLSERVER_REQUEST_TIMEOUT || '60000'),
        maxRows: parseInt(process.env.SQLSERVER_MAX_ROWS || '1000'),
      };

      // Validate configuration
      try {
        ConnectionConfigSchema.parse(config);
      } catch (error) {
        console.error('Invalid configuration:', error);
        process.exit(1);
      }

      if (authMode === 'sql' && (!config.user || !config.password)) {
        console.error('Error: SQLSERVER_USER and SQLSERVER_PASSWORD environment variables are required for SQL auth mode');
        process.exit(1);
      }

      const server = new SqlServerMCPServer();
      
      try {
        await server.initialize(config);
        await server.run();
      } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
      }
    }

    await main();
    
  } catch (error) {
    console.error('Failed to start MCP server:', (error as Error).message);
    process.exit(1);
  }
}

runServer().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});