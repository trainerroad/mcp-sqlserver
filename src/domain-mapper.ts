import fs from 'fs';
import path from 'path';
import { DomainEntity, DomainColumnRename, DomainRelationship } from './types.js';

export class DomainMapper {

  /**
   * Recursively find all *Configuration.cs files under the given directory.
   * Returns empty array for non-existent dirs.
   */
  static findConfigFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
      return [];
    }

    const results: string[] = [];

    const walk = (currentDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('Configuration.cs')) {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results.sort();
  }

  /**
   * Parse a single EF configuration file. Returns null if it can't be parsed.
   */
  static parseConfigFile(filePath: string): DomainEntity | null {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    // 1. Extract entity name from class declaration
    // class FooConfiguration : BaseEntityTypeConfiguration<Foo>
    const classMatch = content.match(
      /class\s+\w+Configuration\s*:\s*\w*(?:EntityTypeConfiguration|BaseEntityTypeConfiguration)\s*<\s*(\w+)\s*>/
    );
    if (!classMatch) {
      return null;
    }
    const entityName = classMatch[1];

    // 2. Extract table name from ToTable("...")
    // Direct ToTable (NOT inside a Map block, i.e. not m.ToTable)
    let tableName = entityName;
    const schema = 'dbo';

    // Find all ToTable calls; distinguish direct vs inside Map block
    // Direct: ToTable("TableName") — not preceded by a lambda variable dot
    const directToTableMatch = content.match(
      /(?<![a-zA-Z0-9_]\s*\.\s*)ToTable\s*\(\s*"([^"]+)"\s*\)/gs
    );

    // Map block m.ToTable (junction table context or fallback)
    const mapToTableMatch = content.match(
      /[a-zA-Z_]\s*\.\s*ToTable\s*\(\s*"([^"]+)"\s*\)/gs
    );

    if (directToTableMatch && directToTableMatch.length > 0) {
      // Extract the table name from the first direct ToTable
      const nameMatch = directToTableMatch[0].match(/ToTable\s*\(\s*"([^"]+)"\s*\)/);
      if (nameMatch) {
        tableName = nameMatch[1];
      }
    } else if (mapToTableMatch && mapToTableMatch.length > 0) {
      // Fallback to Map block ToTable if no direct one
      const nameMatch = mapToTableMatch[0].match(/ToTable\s*\(\s*"([^"]+)"\s*\)/);
      if (nameMatch) {
        tableName = nameMatch[1];
      }
    }

    // 3. Primary key from HasKey(x => x.Prop)
    let primaryKey = 'Id';
    const hasKeyMatch = content.match(
      /HasKey\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)/s
    );
    if (hasKeyMatch) {
      primaryKey = hasKeyMatch[1];
    }

    // 4. TPH discriminator from Requires("Col").HasValue(val)
    let discriminator: { column: string; value: string } | undefined;
    const discriminatorMatch = content.match(
      /Requires\s*\(\s*"([^"]+)"\s*\)\s*\.\s*HasValue\s*\(\s*("?)([^)"]+)\2\s*\)/s
    );
    if (discriminatorMatch) {
      discriminator = {
        column: discriminatorMatch[1],
        value: discriminatorMatch[3],
      };
    }

    // 5. Column renames from Property(x => x.Prop).HasColumnName("Col")
    const columnRenames: DomainColumnRename[] = [];
    const columnRenameRegex = /Property\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)[\s\S]*?\.HasColumnName\s*\(\s*"([^"]+)"\s*\)/gs;
    let colMatch: RegExpExecArray | null;
    while ((colMatch = columnRenameRegex.exec(content)) !== null) {
      const property = colMatch[1];
      const column = colMatch[2];
      if (property !== column) {
        columnRenames.push({ property, column });
      }
    }

    // 6-9. Relationships
    const relationships: DomainRelationship[] = [];

    // 6. Required relationships: HasRequired(x => x.Nav).WithMany(...).HasForeignKey(x => x.FK)
    const requiredRegex = /HasRequired\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)[\s\S]*?\.WithMany\s*\([^)]*\)[\s\S]*?\.HasForeignKey\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)/gs;
    let reqMatch: RegExpExecArray | null;
    while ((reqMatch = requiredRegex.exec(content)) !== null) {
      relationships.push({
        navigation: reqMatch[1],
        targetEntity: reqMatch[1],
        foreignKey: reqMatch[2],
        type: 'required',
      });
    }

    // 7. Optional relationships: HasOptional(x => x.Nav).WithMany(...).HasForeignKey(x => x.FK)
    const optionalRegex = /HasOptional\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)[\s\S]*?\.WithMany\s*\([^)]*\)[\s\S]*?\.HasForeignKey\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)/gs;
    let optMatch: RegExpExecArray | null;
    while ((optMatch = optionalRegex.exec(content)) !== null) {
      relationships.push({
        navigation: optMatch[1],
        targetEntity: optMatch[1],
        foreignKey: optMatch[2],
        type: 'optional',
      });
    }

    // 8. One-to-one: HasRequired(x => x.Nav).WithRequiredPrincipal(...)
    const oneToOneRegex = /HasRequired\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)[\s\S]*?\.WithRequiredPrincipal\s*\([^)]*\)/gs;
    let otoMatch: RegExpExecArray | null;
    while ((otoMatch = oneToOneRegex.exec(content)) !== null) {
      relationships.push({
        navigation: otoMatch[1],
        targetEntity: otoMatch[1],
        foreignKey: '',
        type: 'one-to-one',
      });
    }

    // 9. Many-to-many: HasMany(x => x.Nav).WithMany(...).Map(m => m.ToTable("JT").MapLeftKey("LK").MapRightKey("RK"))
    const manyToManyRegex = /HasMany\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)[\s\S]*?\.WithMany\s*\([^)]*\)[\s\S]*?\.Map\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*ToTable\s*\(\s*"([^"]+)"\s*\)[\s\S]*?\.MapLeftKey\s*\(\s*"([^"]+)"\s*\)[\s\S]*?\.MapRightKey\s*\(\s*"([^"]+)"\s*\)\s*\)/gs;
    let m2mMatch: RegExpExecArray | null;
    while ((m2mMatch = manyToManyRegex.exec(content)) !== null) {
      relationships.push({
        navigation: m2mMatch[1],
        targetEntity: m2mMatch[1],
        foreignKey: '',
        type: 'many-to-many',
        junctionTable: m2mMatch[2],
        leftKey: m2mMatch[3],
        rightKey: m2mMatch[4],
      });
    }

    // 10. Ignored properties from Ignore(x => x.Prop)
    const ignoredProperties: string[] = [];
    const ignoreRegex = /Ignore\s*\(\s*\w+\s*=>\s*\w+\s*\.\s*(\w+)\s*\)/gs;
    let ignMatch: RegExpExecArray | null;
    while ((ignMatch = ignoreRegex.exec(content)) !== null) {
      ignoredProperties.push(ignMatch[1]);
    }

    const result: DomainEntity = {
      entityName,
      tableName,
      schema,
      primaryKey,
      columnRenames,
      relationships,
      ignoredProperties,
    };
    if (discriminator) {
      result.discriminator = discriminator;
    }
    return result;
  }

  /**
   * Parse all configs and generate markdown domain context.
   */
  static generateDomainContext(domainSourcePath: string): string | null {
    const configDir = path.join(
      domainSourcePath,
      'EntityFramework',
      'Domain',
      'Configurations'
    );

    if (!fs.existsSync(configDir)) {
      return null;
    }

    const files = DomainMapper.findConfigFiles(configDir);
    const entities: DomainEntity[] = [];
    let skipped = 0;

    for (const file of files) {
      const entity = DomainMapper.parseConfigFile(file);
      if (entity) {
        entities.push(entity);
      } else {
        skipped++;
      }
    }

    if (entities.length === 0) {
      return null;
    }

    // Sort entities alphabetically
    entities.sort((a, b) => a.entityName.localeCompare(b.entityName));

    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];

    lines.push('# Domain Entity Mappings');
    lines.push(
      `> ${entities.length} entities parsed from EF configurations. ${skipped} files skipped. Generated ${today}`
    );
    lines.push('');

    // Entity -> Table Index
    lines.push('## Entity -> Table Index');
    for (const e of entities) {
      let line = `${e.entityName} -> ${e.schema}.${e.tableName}`;
      if (e.discriminator) {
        line += ` (discriminator: ${e.discriminator.column}=${e.discriminator.value})`;
      }
      lines.push(line);
    }
    lines.push('');

    // Column Renames
    const allRenames: { entity: string; rename: DomainColumnRename }[] = [];
    for (const e of entities) {
      for (const r of e.columnRenames) {
        allRenames.push({ entity: e.entityName, rename: r });
      }
    }
    if (allRenames.length > 0) {
      lines.push('## Column Renames');
      for (const { entity, rename } of allRenames) {
        lines.push(`${entity}.${rename.property} -> ${rename.column}`);
      }
      lines.push('');
    }

    // Relationships
    const allRels: { entity: string; rel: DomainRelationship }[] = [];
    for (const e of entities) {
      for (const r of e.relationships) {
        allRels.push({ entity: e.entityName, rel: r });
      }
    }
    if (allRels.length > 0) {
      lines.push('## Relationships');
      for (const { entity, rel } of allRels) {
        switch (rel.type) {
          case 'required':
            lines.push(
              `${entity}.${rel.navigation} -> ${rel.targetEntity} via ${rel.foreignKey} (required)`
            );
            break;
          case 'optional':
            lines.push(
              `${entity}.${rel.navigation} -> ${rel.targetEntity} via ${rel.foreignKey} (optional)`
            );
            break;
          case 'one-to-one':
            lines.push(
              `${entity}.${rel.navigation} -> ${rel.targetEntity} (1:1)`
            );
            break;
          case 'many-to-many':
            lines.push(
              `${entity}.${rel.navigation} -> ${rel.targetEntity}[] via ${rel.junctionTable}(${rel.leftKey}, ${rel.rightKey})`
            );
            break;
        }
      }
      lines.push('');
    }

    // Join with \r\n for Windows line endings
    return lines.join('\r\n');
  }
}
