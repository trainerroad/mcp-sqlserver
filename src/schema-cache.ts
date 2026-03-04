import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import sql from 'mssql';
import { DomainMapper } from './domain-mapper.js';

interface SchemaColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
}

interface SchemaFK {
  table_schema: string;
  table_name: string;
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
}

interface SchemaPK {
  table_schema: string;
  table_name: string;
  column_name: string;
}

export interface SchemaSnapshotResult {
  markdown: string;
  tables: number;
  columns: number;
}

export class SchemaCache {
  readonly cachePath: string;
  readonly domainSourcePath: string | undefined;
  private servedThisSession = false;

  constructor(cachePath: string, domainSourcePath?: string) {
    this.cachePath = cachePath;
    this.domainSourcePath = domainSourcePath;
  }

  /**
   * Returns the schema markdown if it hasn't been served yet this session.
   * Auto-generates the cache file if it doesn't exist.
   * Returns null on subsequent calls (schema already in context).
   */
  async getSchemaOnce(queryFn: <T>(sql: string) => Promise<sql.IResult<T>>, dbName: string): Promise<string | null> {
    if (this.servedThisSession) {
      return null;
    }
    this.servedThisSession = true;

    // Try reading existing cache
    if (existsSync(this.cachePath)) {
      return readFileSync(this.cachePath, 'utf-8');
    }

    // Generate cache
    const result = await this.generateSchema(queryFn, dbName);
    return result.markdown;
  }

  /**
   * Force-regenerate the schema cache file.
   */
  async generateSchema(queryFn: <T>(sql: string) => Promise<sql.IResult<T>>, dbName: string): Promise<SchemaSnapshotResult> {
    const columns = await queryFn<SchemaColumn>(`
      SELECT
        c.TABLE_SCHEMA as table_schema,
        c.TABLE_NAME as table_name,
        c.COLUMN_NAME as column_name,
        c.DATA_TYPE as data_type,
        c.CHARACTER_MAXIMUM_LENGTH as character_maximum_length,
        c.NUMERIC_PRECISION as numeric_precision,
        c.NUMERIC_SCALE as numeric_scale,
        c.IS_NULLABLE as is_nullable
      FROM INFORMATION_SCHEMA.COLUMNS c
      INNER JOIN INFORMATION_SCHEMA.TABLES t
        ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `);

    const pks = await queryFn<SchemaPK>(`
      SELECT
        s.name as table_schema,
        t.name as table_name,
        c.name as column_name
      FROM sys.indexes i
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      INNER JOIN sys.tables t ON i.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE i.is_primary_key = 1
      ORDER BY s.name, t.name
    `);

    const fks = await queryFn<SchemaFK>(`
      SELECT
        OBJECT_SCHEMA_NAME(fk.parent_object_id) as table_schema,
        OBJECT_NAME(fk.parent_object_id) as table_name,
        COL_NAME(fkc.parent_object_id, fkc.parent_column_id) as column_name,
        OBJECT_SCHEMA_NAME(fk.referenced_object_id) as referenced_schema,
        OBJECT_NAME(fk.referenced_object_id) as referenced_table,
        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) as referenced_column
      FROM sys.foreign_keys fk
      INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      ORDER BY table_schema, table_name
    `);

    // Build lookup sets
    const pkSet = new Set(
      pks.recordset.map(pk => `${pk.table_schema}.${pk.table_name}.${pk.column_name}`)
    );
    const fkMap = new Map<string, SchemaFK>();
    for (const fk of fks.recordset) {
      fkMap.set(`${fk.table_schema}.${fk.table_name}.${fk.column_name}`, fk);
    }

    // Group columns by table
    const tables = new Map<string, SchemaColumn[]>();
    for (const col of columns.recordset) {
      const key = `${col.table_schema}.${col.table_name}`;
      if (!tables.has(key)) {
        tables.set(key, []);
      }
      tables.get(key)!.push(col);
    }

    // Build compact markdown
    const lines: string[] = [
      `# ${dbName} Schema`,
      ``,
      `> ${tables.size} tables, ${columns.recordset.length} columns. Generated ${new Date().toISOString().split('T')[0]}`,
      ``,
    ];

    for (const [tableKey, cols] of tables) {
      lines.push(`## ${tableKey}`);

      const colParts: string[] = [];
      for (const col of cols) {
        const colKey = `${col.table_schema}.${col.table_name}.${col.column_name}`;
        let typeStr = col.data_type;
        if (col.character_maximum_length !== null && col.character_maximum_length !== -1) {
          typeStr += `(${col.character_maximum_length})`;
        } else if (col.character_maximum_length === -1) {
          typeStr += `(max)`;
        } else if (col.numeric_precision !== null && col.numeric_scale !== null && col.numeric_scale > 0) {
          typeStr += `(${col.numeric_precision},${col.numeric_scale})`;
        }

        const flags: string[] = [];
        if (pkSet.has(colKey)) flags.push('PK');
        const fk = fkMap.get(colKey);
        if (fk) flags.push(`FK\u2192${fk.referenced_schema}.${fk.referenced_table}.${fk.referenced_column}`);
        if (col.is_nullable === 'YES') flags.push('null');

        const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';
        colParts.push(`${col.column_name} ${typeStr}${flagStr}`);
      }

      lines.push(colParts.join(' \u00b7 '));
      lines.push('');
    }

    let markdown = lines.join('\r\n');

    // Append domain entity mappings if configured
    if (this.domainSourcePath) {
      try {
        const domainContext = DomainMapper.generateDomainContext(this.domainSourcePath);
        if (domainContext) {
          markdown += '\r\n' + domainContext;
        }
      } catch (error) {
        console.error('Warning: Failed to generate domain context:', error);
      }
    }

    // Write cache file
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, markdown, 'utf-8');

    return {
      markdown,
      tables: tables.size,
      columns: columns.recordset.length,
    };
  }
}
