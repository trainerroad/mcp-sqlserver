import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DomainMapper } from '../domain-mapper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

describe('DomainMapper.parseConfigFile', () => {
  it('parses a simple configuration with table name and relationships', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'SimpleConfiguration.cs')
    );
    expect(result).not.toBeNull();
    expect(result!.entityName).toBe('Activity');
    expect(result!.tableName).toBe('Activity');
    expect(result!.primaryKey).toBe('Id');
    expect(result!.relationships).toHaveLength(3);

    const memberRel = result!.relationships.find(r => r.navigation === 'Member');
    expect(memberRel).toBeDefined();
    expect(memberRel!.type).toBe('required');
    expect(memberRel!.foreignKey).toBe('MemberId');

    const cyclingRel = result!.relationships.find(r => r.navigation === 'CyclingActivity');
    expect(cyclingRel).toBeDefined();
    expect(cyclingRel!.type).toBe('one-to-one');

    const workoutRel = result!.relationships.find(r => r.navigation === 'Workout');
    expect(workoutRel).toBeDefined();
    expect(workoutRel!.type).toBe('optional');
    expect(workoutRel!.foreignKey).toBe('WorkoutId');
  });

  it('parses entity-to-table name mapping when names differ', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'RenamedTableConfiguration.cs')
    );
    expect(result).not.toBeNull();
    expect(result!.entityName).toBe('WorkoutRecord');
    expect(result!.tableName).toBe('CyclingActivity');
  });

  it('parses many-to-many relationships with junction tables', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'RenamedTableConfiguration.cs')
    );
    const m2m = result!.relationships.find(r => r.type === 'many-to-many');
    expect(m2m).toBeDefined();
    expect(m2m!.junctionTable).toBe('ActivityFollower');
    expect(m2m!.leftKey).toBe('ActivityId');
    expect(m2m!.rightKey).toBe('MemberId');
  });

  it('parses column renames', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'ColumnRenameConfiguration.cs')
    );
    expect(result!.columnRenames).toHaveLength(1);
    expect(result!.columnRenames[0]).toEqual({
      property: 'Type',
      column: 'Classification',
    });
  });

  it('parses TPH discriminator and Ignore calls', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'DiscriminatorConfiguration.cs')
    );
    expect(result).not.toBeNull();
    expect(result!.entityName).toBe('BaseTeam');
    expect(result!.tableName).toBe('Team');
    expect(result!.discriminator).toEqual({ column: 'Type', value: '0' });
    expect(result!.ignoredProperties).toContain('Members');
    expect(result!.ignoredProperties).toContain('DisplayName');
  });

  it('returns null for non-parseable files', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'NotParseable.cs')
    );
    expect(result).toBeNull();
  });

  it('returns null for non-existent files', () => {
    const result = DomainMapper.parseConfigFile(
      join(fixturesDir, 'DoesNotExist.cs')
    );
    expect(result).toBeNull();
  });
});

describe('DomainMapper.findConfigFiles', () => {
  it('finds all Configuration.cs files in fixtures', () => {
    const files = DomainMapper.findConfigFiles(fixturesDir);
    const configFiles = files.filter(f => f.endsWith('Configuration.cs'));
    expect(configFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('returns empty array for non-existent directory', () => {
    const files = DomainMapper.findConfigFiles('/nonexistent/path');
    expect(files).toEqual([]);
  });
});

describe('DomainMapper.generateDomainContext', () => {
  it('returns null for non-existent path', () => {
    const result = DomainMapper.generateDomainContext('/nonexistent/path');
    expect(result).toBeNull();
  });

  it('generates markdown with entity mappings from fixture files', () => {
    const domainRoot = join(fixturesDir, 'domain-root');
    const result = DomainMapper.generateDomainContext(domainRoot);
    expect(result).not.toBeNull();

    // Header
    expect(result).toContain('# Domain Entity Mappings');
    expect(result).toMatch(/4 entities parsed/);

    // Entity -> Table Index entries (4 parseable configs, NotParseable.cs skipped)
    expect(result).toContain('Activity -> dbo.Activity');
    expect(result).toContain('WorkoutRecord -> dbo.CyclingActivity');
    expect(result).toContain('CyclingActivityMlClassification -> dbo.WorkoutRecordMlClassification');
    expect(result).toContain('BaseTeam -> dbo.Team');
    expect(result).toContain('discriminator: Type=0');

    // Column Renames section
    expect(result).toContain('## Column Renames');
    expect(result).toContain('CyclingActivityMlClassification.Type -> Classification');

    // Relationships section
    expect(result).toContain('## Relationships');
    expect(result).toContain('Activity.Member -> Member via MemberId (required)');
    expect(result).toContain('Activity.Workout -> Workout via WorkoutId (optional)');
    expect(result).toContain('Activity.CyclingActivity -> CyclingActivity (1:1)');
    expect(result).toContain('WorkoutRecord.Followers -> Followers[] via ActivityFollower(ActivityId, MemberId)');
  });
});
