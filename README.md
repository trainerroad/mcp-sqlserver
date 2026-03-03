# MSSQL Read-Only MCP Server for Claude Code

An MCP (Model Context Protocol) server that lets Claude Code run read-only queries against Microsoft SQL Server. Supports SQL auth and Azure AD. All connections use `ApplicationIntent=ReadOnly` and queries are validated to block any write operations.

Based on [bilims/mcp-sqlserver](https://github.com/bilims/mcp-sqlserver) with added Azure AD authentication, hardcoded read-only intent, and automatic schema caching.

## Tools

| Tool | Purpose |
|------|---------|
| `execute_query` | Run read-only SELECT queries. Automatically includes the full database schema on first call. |
| `list_tables` | List all tables in a database or schema |
| `list_views` | List all views in a database or schema |
| `describe_table` | Get column details for a specific table |
| `get_foreign_keys` | Get foreign key relationships |
| `get_table_stats` | Get row counts and table sizes |
| `list_databases` | List all databases on the server |
| `get_server_info` | Get SQL Server version and edition |
| `test_connection` | Verify the connection works |
| `snapshot_schema` | Force-regenerate the schema cache file |

## Read-Only Safety

Three independent layers prevent any write operations:

1. **Connection level** — `ApplicationIntent=ReadOnly` is hardcoded (routes to read replicas when available)
2. **Query validation** — Only `SELECT` and `WITH` statements are allowed. 17 keywords are blocked (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `EXEC`, `GRANT`, etc.) plus SQL injection pattern detection
3. **Database permissions** — Use a `db_datareader`-only account for defense in depth

## Setup

### Prerequisites

- **Node.js 18+**
- **Claude Code**
- **Azure CLI** (only if using Azure AD auth): https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

### Step 1: Clone, install, and build

```bash
git clone https://github.com/trainerroad/mcp-sqlserver.git ~/.claude/mcp-sqlserver
cd ~/.claude/mcp-sqlserver
npm install
npm run build
```

### Step 2: Choose your authentication method

#### Option A: Azure AD (recommended for Azure SQL)

1. Install the Azure CLI if you don't have it:
   ```bash
   # Windows (winget)
   winget install Microsoft.AzureCLI

   # macOS
   brew install azure-cli

   # Linux
   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
   ```

2. Sign in with the account that has database access:
   ```bash
   az login
   ```

3. Register the MCP server:
   ```bash
   claude mcp add mssql-readonly -s user \
     -e SQLSERVER_HOST=your-server.database.windows.net \
     -e SQLSERVER_DATABASE=your-database \
     -e SQLSERVER_AUTH_MODE=aad-default \
     -e SQLSERVER_ENCRYPT=true \
     -e SQLSERVER_TRUST_CERT=false \
     -- node ~/.claude/mcp-sqlserver/dist/index.js
   ```

#### Option B: SQL Server authentication

```bash
claude mcp add mssql-readonly -s user \
  -e SQLSERVER_HOST=your-server.database.windows.net \
  -e SQLSERVER_DATABASE=your-database \
  -e SQLSERVER_USER=your-username \
  -e SQLSERVER_PASSWORD=your-password \
  -e SQLSERVER_ENCRYPT=true \
  -e SQLSERVER_TRUST_CERT=false \
  -- node ~/.claude/mcp-sqlserver/dist/index.js
```

For on-premises SQL Server with self-signed certificates, set `SQLSERVER_TRUST_CERT=true`.

### Step 3: Verify

```bash
claude mcp list
```

Should show: `mssql-readonly: ... ✓ Connected`

### Step 4: Start a new Claude Code session

The MCP server only loads in **new** sessions. Try:
- *"Test the SQL Server connection"*
- *"List all tables in the database"*
- *"Show me the top 10 rows from the Users table"*

## Schema Cache

On the first `execute_query` call in a session, the server automatically:

1. Checks for a cached schema file at `.schema-cache/<database-name>.md` (relative to the install directory)
2. If none exists, queries the database for all tables, columns, primary keys, and foreign keys
3. Writes a compact markdown cache file and includes it in the response

This means Claude Code gets full schema context on the first query — no extra tool calls needed. Subsequent queries in the same session skip the schema (already in context).

**To refresh the cache** after schema changes, call the `snapshot_schema` tool.

**To use a custom cache path**, set the `SQLSERVER_SCHEMA_CACHE_PATH` environment variable.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SQLSERVER_HOST` | Yes | `localhost` | Server hostname |
| `SQLSERVER_DATABASE` | No | `master` | Default database |
| `SQLSERVER_AUTH_MODE` | No | `sql` | Auth method: `sql`, `aad-default`, `aad-password`, `aad-service-principal` |
| `SQLSERVER_USER` | For SQL auth | | SQL Server username |
| `SQLSERVER_PASSWORD` | For SQL auth | | SQL Server password |
| `SQLSERVER_CLIENT_ID` | No | | Azure AD application (client) ID |
| `SQLSERVER_CLIENT_SECRET` | For service principal | | Azure AD client secret |
| `SQLSERVER_TENANT_ID` | No | | Azure AD tenant ID |
| `SQLSERVER_PORT` | No | `1433` | Server port |
| `SQLSERVER_ENCRYPT` | No | `true` | Enable TLS encryption |
| `SQLSERVER_TRUST_CERT` | No | `true` | Trust server certificate (set `false` for Azure SQL) |
| `SQLSERVER_MAX_ROWS` | No | `1000` | Max rows per query (up to 10,000) |
| `SQLSERVER_CONNECTION_TIMEOUT` | No | `30000` | Connection timeout in ms |
| `SQLSERVER_REQUEST_TIMEOUT` | No | `60000` | Query timeout in ms |
| `SQLSERVER_SCHEMA_CACHE_PATH` | No | Auto-derived | Override schema cache file path |

## Azure AD Auth Modes

| Mode | Use Case | Credential Source |
|------|----------|-------------------|
| `aad-default` | Developer machines, Azure VMs | `az login`, managed identity, env vars — tries multiple sources automatically |
| `aad-password` | Username/password with Azure AD | Requires `SQLSERVER_USER`, `SQLSERVER_PASSWORD`, `SQLSERVER_CLIENT_ID` |
| `aad-service-principal` | CI/CD, automation | Requires `SQLSERVER_CLIENT_ID`, `SQLSERVER_CLIENT_SECRET`, `SQLSERVER_TENANT_ID` |

## Troubleshooting

### Azure AD: "AADSTS" errors
- Run `az account show` to verify you're signed in with the correct account
- Run `az login` to re-authenticate if your token has expired
- Ensure your Azure AD account has been granted access to the database (`CREATE USER [user@domain.com] FROM EXTERNAL PROVIDER`)

### Connection refused / timeout
- Verify the server hostname and port are correct
- Check firewall rules — Azure SQL requires your IP to be allowed
- For Azure SQL, ensure `SQLSERVER_ENCRYPT=true` and `SQLSERVER_TRUST_CERT=false`

### Permission errors on queries
- The account needs at minimum `db_datareader` role membership
- For schema discovery, access to `INFORMATION_SCHEMA` views and `sys.` catalog views is required

### Schema cache not generating
- Ensure the server process has write access to its install directory (or set `SQLSERVER_SCHEMA_CACHE_PATH` to a writable location)
- Check stderr output for errors: `claude mcp list` shows server logs on failure

---

## Claude Code Automated Setup Instructions

<!-- This section is for Claude Code to follow when a user asks it to set up this MCP server. -->

When a user asks you to set up this MCP server, follow these steps exactly:

### Step 1: Clone the repo

Clone into the user's Claude config directory:
- **Windows (Git Bash):** `~/.claude/mcp-sqlserver` resolves to `/c/Users/<username>/.claude/mcp-sqlserver`
- **macOS/Linux:** `~/.claude/mcp-sqlserver`

```bash
git clone https://github.com/trainerroad/mcp-sqlserver.git ~/.claude/mcp-sqlserver
```

If the directory already exists, run `git -C ~/.claude/mcp-sqlserver pull` instead.

### Step 2: Install dependencies and build

```bash
cd ~/.claude/mcp-sqlserver && npm install && npm run build
```

### Step 3: Determine auth method

Ask the user how they authenticate to their SQL Server:
- **Azure AD** — Continue to Step 3a.
- **SQL auth** — They need a username and password. Skip to Step 4.

### Step 3a: Verify Azure CLI is installed and signed in

Run `az --version` to check if the Azure CLI is installed. If the command is not found, stop and tell the user:

> **Azure CLI is required for Azure AD authentication but is not installed.**
> Install it from https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
>
> Quick install commands:
> - **Windows:** `winget install Microsoft.AzureCLI`
> - **macOS:** `brew install azure-cli`
> - **Linux:** `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`
>
> After installing, restart your terminal and run this setup again.

Do NOT continue with the remaining steps until `az --version` succeeds.

Once Azure CLI is confirmed installed, run `az account show --query "{name:name, user:user.name}" -o table` to check the login status.

- If signed in, confirm the account shown is the one with database access. If not, tell the user to run `az login` and sign in with the correct account.
- If not signed in (error), tell the user to run `az login` and complete the browser sign-in flow, then re-run `az account show` to confirm.

### Step 4: Register the MCP server

Use the **absolute path** to the built entry point:
- **Windows:** `C:/Users/<username>/.claude/mcp-sqlserver/dist/index.js`
- **macOS:** `/Users/<username>/.claude/mcp-sqlserver/dist/index.js`
- **Linux:** `/home/<username>/.claude/mcp-sqlserver/dist/index.js`

For Azure AD:
```bash
claude mcp add mssql-readonly -s user \
  -e SQLSERVER_HOST=<server> \
  -e SQLSERVER_DATABASE=<database> \
  -e SQLSERVER_AUTH_MODE=aad-default \
  -e SQLSERVER_ENCRYPT=true \
  -e SQLSERVER_TRUST_CERT=false \
  -- node <ABSOLUTE_PATH>/dist/index.js
```

For SQL auth:
```bash
claude mcp add mssql-readonly -s user \
  -e SQLSERVER_HOST=<server> \
  -e SQLSERVER_DATABASE=<database> \
  -e SQLSERVER_USER=<username> \
  -e SQLSERVER_PASSWORD=<password> \
  -e SQLSERVER_ENCRYPT=true \
  -e SQLSERVER_TRUST_CERT=false \
  -- node <ABSOLUTE_PATH>/dist/index.js
```

### Step 5: Verify

Run `claude mcp list` and confirm the mssql-readonly server shows as connected.

Tell the user: **Setup complete! Start a new Claude Code session and try "Test the SQL Server connection" or "List all tables in the database".**

Note: The MCP server will only be available in **new** Claude Code sessions, not the current one.
