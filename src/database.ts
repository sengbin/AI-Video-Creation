import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { GeneratedEpisodeContent, MAX_GENERATED_EPISODES } from './episodeContent';

/** 新增一条提示词记录及其项目归属。 */
export interface NewPromptRecord {
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string;
  /** 项目标识；缺省或 '0' 表示未归属项目。 */
  readonly projectId?: string;
  readonly schema: unknown;
  readonly data: unknown;
}

/** 数据库中的完整提示词记录。 */
export interface PromptRecord {
  readonly id: string;
  readonly title: string | undefined;
  readonly categoryId: string;
  readonly categoryName: string;
  /** 项目标识；'0' 表示未归属项目。 */
  readonly projectId: string;
  readonly schema: unknown;
  readonly data: unknown;
  readonly generatedResultChinese: string | undefined;
  readonly generatedResultEnglish: string | undefined;
  readonly generatedResultContent: string | undefined;
  readonly createdAt: string;
  readonly generatedAt: string | undefined;
}

/** 成功生成后要保存的唯一结果类型。 */
export type GeneratedOutputReplacement =
  | { readonly type: 'content'; readonly content: string }
  | { readonly type: 'prompts'; readonly contentZh: string; readonly contentEn: string }
  | { readonly type: 'episodes'; readonly episodes: readonly GeneratedEpisodeContent[] };

/** 修改提示词记录时可更新的字段。 */
export interface UpdatedPromptRecord {
  readonly title: string;
  /** 新项目标识；'0' 表示未归属项目。 */
  readonly projectId: string;
  readonly schema: unknown;
  readonly data: unknown;
}

/** 表示项目管理列表中的一条项目。 */
export interface WorkProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建项目时需要保存的字段。 */
export interface NewWorkProject {
  readonly name: string;
  readonly description: string;
}

interface StoredPromptRecord {
  readonly id: string;
  readonly title: string | null;
  readonly category_id: string;
  readonly category_name: string;
  readonly project_id: string;
  readonly schema_json: string;
  readonly data_json: string;
  readonly generated_result_chinese: string | null;
  readonly generated_result_english: string | null;
  readonly generated_result_content: string | null;
  readonly created_at: string;
  readonly generated_at: string | null;
}

/**
 * 管理扩展用户级提示词记录数据库。
 */
export class PromptDatabase implements vscode.Disposable {
  private readonly recordsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeRecords = this.recordsChangedEmitter.event;

  private constructor(private readonly connection: DatabaseSync) {}

  /**
   * 在扩展全局存储目录中打开或首次创建数据库。
   * @param storageUri 扩展全局存储目录。
   */
  static async open(storageUri: vscode.Uri): Promise<PromptDatabase> {
    await vscode.workspace.fs.createDirectory(storageUri);

    const databasePath = vscode.Uri.joinPath(storageUri, 'creative-projects.sqlite').fsPath;
    const legacyDatabasePath = vscode.Uri.joinPath(storageUri, 'prompt-records.sqlite').fsPath;
    if (existsSync(databasePath) && existsSync(legacyDatabasePath)) {
      throw new Error('项目数据库与旧版记录数据库同时存在，无法安全迁移。');
    }
    if (existsSync(legacyDatabasePath)) {
      renameSync(legacyDatabasePath, databasePath);
    }
    const connection = new DatabaseSync(databasePath);

    try {
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec(`
        CREATE TABLE IF NOT EXISTS prompt_records (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT,
          category_id TEXT NOT NULL,
          category_name TEXT NOT NULL,
          project_id TEXT NOT NULL DEFAULT '0',
          schema_json TEXT NOT NULL,
          data_json TEXT NOT NULL,
          generated_result_chinese TEXT,
          generated_result_english TEXT,
          generated_result_content TEXT,
          created_at TEXT NOT NULL,
          generated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS prompt_records_category_created_idx
          ON prompt_records (category_id, created_at DESC);
      `);
      migratePromptRecords(connection);
    } catch (error) {
      connection.close();
      throw error;
    }

    return new PromptDatabase(connection);
  }

  /**
  * 保存分类、项目归属、字段模板快照和表单数据。
   * @param input 要保存的记录内容。
   */
  saveRecord(input: NewPromptRecord): PromptRecord {
    const projectId = input.projectId ?? '0';
    this.assertWorkProjectExists(projectId);
    const record = {
      ...input,
      projectId,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const schemaJson = serializeJson(record.schema, 'schema');
    const dataJson = serializeJson(record.data, 'data');

    this.connection.prepare(`
      INSERT INTO prompt_records (
        id, title, category_id, category_name, project_id, schema_json, data_json, created_at, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.title,
      record.categoryId,
      record.categoryName,
      record.projectId,
      schemaJson,
      dataJson,
      record.createdAt,
      null
    );

    this.recordsChangedEmitter.fire();
    return {
      ...record,
      generatedResultChinese: undefined,
      generatedResultEnglish: undefined,
      generatedResultContent: undefined,
      generatedAt: undefined
    };
  }

  /**
   * 查询记录，可按分类标识和项目筛选。
   * @param categoryId 分类标识；不传时查询全部记录。
   * @param projectId 项目标识；'0' 表示未归属项目，不传时不按项目筛选。
   */
  listRecords(categoryId?: string, projectId?: string): PromptRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (categoryId !== undefined) {
      conditions.push('category_id = ?');
      parameters.push(categoryId);
    }
    if (projectId !== undefined) {
      conditions.push('project_id = ?');
      parameters.push(projectId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.connection.prepare(`
      SELECT * FROM prompt_records ${where} ORDER BY created_at DESC, id DESC
    `).all(...parameters);

    return (rows as unknown as StoredPromptRecord[]).map(readRecord);
  }

  /**
   * 按记录标识查询单条记录。
   * @param id 记录标识。
   */
  getRecord(id: string): PromptRecord | undefined {
    const row = this.connection.prepare(`
      SELECT * FROM prompt_records WHERE id = ?
    `).get(id) as StoredPromptRecord | undefined;

    return row ? readRecord(row) : undefined;
  }

  /**
   * 更新记录标题、字段模板和数据。
   * @param id 记录标识。
   * @param input 更新后的记录内容。
   * @returns 更新后的记录；记录不存在时返回 undefined。
   */
  updateRecord(id: string, input: UpdatedPromptRecord): PromptRecord | undefined {
    this.assertWorkProjectExists(input.projectId);
    const schemaJson = serializeJson(input.schema, 'schema');
    const dataJson = serializeJson(input.data, 'data');
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET title = ?, project_id = ?, schema_json = ?, data_json = ?
      WHERE id = ?
    `).run(input.title, input.projectId, schemaJson, dataJson, id);

    if (Number(result.changes) === 0) {
      return undefined;
    }

    this.recordsChangedEmitter.fire();
    return this.getRecord(id);
  }

  /**
    * 保存指定记录最近一次生成的中英文提示词。
   * @param id 提示词记录标识。
    * @param contentZh Copilot 返回的中文提示词。
    * @param contentEn Copilot 返回的英文提示词。
   * @returns 更新后的记录；记录不存在时返回 undefined。
   */
  updateGeneratedResult(id: string, contentZh: string, contentEn: string): PromptRecord | undefined {
    const generatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET generated_result_chinese = ?, generated_result_english = ?, generated_at = ?
      WHERE id = ?
    `).run(contentZh, contentEn, generatedAt, id);

    if (Number(result.changes) === 0) {
      return undefined;
    }

    this.recordsChangedEmitter.fire();
    return this.getRecord(id);
  }

  /**
  * 保存创作记录的完整作品内容。
  * @param id 创作记录标识。
  * @param content 完整作品正文。
   * @returns 更新后的记录；记录不存在时返回 undefined。
   */
  updateGeneratedContent(id: string, content: string): PromptRecord | undefined {
    const generatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET generated_result_content = ?, generated_at = ?
      WHERE id = ?
    `).run(content, generatedAt, id);

    if (Number(result.changes) === 0) {
      return undefined;
    }

    this.recordsChangedEmitter.fire();
    return this.getRecord(id);
  }

  /** 在同一事务中清除指定记录的全部旧生成结果并保存本次结果。 */
  replaceGeneratedOutput(id: string, output: GeneratedOutputReplacement): PromptRecord | undefined {
    const episodes = output.type === 'episodes' ? output.episodes : undefined;
    if (episodes) {
      if (episodes.length < 1 || episodes.length > MAX_GENERATED_EPISODES) {
        throw new Error(`分集数量必须在 1 到 ${MAX_GENERATED_EPISODES} 集之间。`);
      }
      episodes.forEach((episode, index) => {
        if (episode.episodeNumber !== index + 1 || !episode.title.trim() || !episode.content.trim()) {
          throw new Error('每集必须按顺序提供连续集数、标题和正文。');
        }
      });
    }

    const generatedAt = new Date().toISOString();
    const contentZh = output.type === 'prompts' ? output.contentZh : null;
    const contentEn = output.type === 'prompts' ? output.contentEn : null;
    const content = output.type === 'content' ? output.content : null;
    this.connection.exec('BEGIN');
    try {
      const result = this.connection.prepare(`
        UPDATE prompt_records
        SET generated_result_chinese = ?, generated_result_english = ?, generated_result_content = ?, generated_at = ?
        WHERE id = ?
      `).run(contentZh, contentEn, content, generatedAt, id);
      if (Number(result.changes) === 0) {
        this.connection.exec('ROLLBACK');
        return undefined;
      }

      this.connection.prepare('DELETE FROM generated_episode_contents WHERE record_id = ?').run(id);
      if (episodes) {
        const insertEpisode = this.connection.prepare(`
          INSERT INTO generated_episode_contents (record_id, episode_number, title, content, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const episode of episodes) {
          insertEpisode.run(id, episode.episodeNumber, episode.title.trim(), episode.content.trim(), generatedAt);
        }
      }
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }

    this.recordsChangedEmitter.fire();
    return this.getRecord(id);
  }

  /** 查询指定创作任务已保存的分集内容。 */
  listGeneratedEpisodeContents(recordId: string): GeneratedEpisodeContent[] {
    const rows = this.connection.prepare(`
      SELECT episode_number, title, content
      FROM generated_episode_contents
      WHERE record_id = ?
      ORDER BY episode_number
    `).all(recordId) as { episode_number: number; title: string; content: string }[];

    return rows.map((row) => ({
      episodeNumber: row.episode_number,
      title: row.title,
      content: row.content
    }));
  }

  /** 以单个事务替换指定任务的全部分集内容。 */
  saveGeneratedEpisodeContents(id: string, episodes: readonly GeneratedEpisodeContent[]): boolean {
    if (episodes.length < 1 || episodes.length > MAX_GENERATED_EPISODES) {
      throw new Error(`分集数量必须在 1 到 ${MAX_GENERATED_EPISODES} 集之间。`);
    }
    episodes.forEach((episode, index) => {
      if (episode.episodeNumber !== index + 1 || !episode.title.trim() || !episode.content.trim()) {
        throw new Error('每集必须按顺序提供连续集数、标题和正文。');
      }
    });
    if (!this.connection.prepare('SELECT 1 FROM prompt_records WHERE id = ?').get(id)) {
      return false;
    }

    const generatedAt = new Date().toISOString();
    const insertEpisode = this.connection.prepare(`
      INSERT INTO generated_episode_contents (record_id, episode_number, title, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.connection.exec('BEGIN');
    try {
      this.connection.prepare('DELETE FROM generated_episode_contents WHERE record_id = ?').run(id);
      for (const episode of episodes) {
        insertEpisode.run(id, episode.episodeNumber, episode.title.trim(), episode.content.trim(), generatedAt);
      }
      this.connection.prepare('UPDATE prompt_records SET generated_at = ? WHERE id = ?').run(generatedAt, id);
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }

    this.recordsChangedEmitter.fire();
    return true;
  }

  /**
   * 按记录标识删除记录。
   * @param id 记录标识。
   * @returns 是否删除了记录。
   */
  deleteRecord(id: string): boolean {
    const result = this.connection.prepare(`
      DELETE FROM prompt_records WHERE id = ?
    `).run(id);

    const deleted = Number(result.changes) > 0;
    if (deleted) {
      this.recordsChangedEmitter.fire();
    }

    return deleted;
  }

  /**
   * 返回按创建时间排序的全部项目。
   * @returns 项目列表。
   */
  listWorkProjects(): WorkProject[] {
    const rows = this.connection.prepare(`
      SELECT id, name, description, created_at, updated_at
      FROM projects ORDER BY created_at DESC, id DESC
    `).all() as unknown as {
      id: string; name: string; description: string; created_at: string; updated_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  /**
   * 创建一个项目。
   * @param input 项目名称和描述。
   * @returns 已保存的项目。
   * @throws 名称为空或与现有项目重复时抛出错误。
   */
  createWorkProject(input: NewWorkProject): WorkProject {
    const name = input.name.trim();
    if (!name) {
      throw new Error('项目名称不能为空。');
    }
    const project = {
      id: randomUUID(),
      name,
      description: input.description,
      createdAt: new Date().toISOString()
    };
    try {
      this.connection.prepare(`
        INSERT INTO projects (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.id, project.name, project.description, project.createdAt, project.createdAt);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error('项目名称已存在。');
      }
      throw error;
    }
    this.recordsChangedEmitter.fire();
    return { ...project, updatedAt: project.createdAt };
  }

  /**
   * 更新项目名称和描述。
   * @param id 项目标识。
   * @param input 更新后的项目名称和描述。
   * @returns 更新后的项目；不存在时返回 undefined。
   */
  updateWorkProject(id: string, input: NewWorkProject): WorkProject | undefined {
    const name = input.name.trim();
    if (!name) {
      throw new Error('项目名称不能为空。');
    }
    const updatedAt = new Date().toISOString();
    try {
      const result = this.connection.prepare(`
        UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?
      `).run(name, input.description, updatedAt, id);
      if (Number(result.changes) === 0) {
        return undefined;
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error('项目名称已存在。');
      }
      throw error;
    }
    this.recordsChangedEmitter.fire();
    const row = this.connection.prepare(`
      SELECT id, name, description, created_at, updated_at FROM projects WHERE id = ?
    `).get(id) as {
      id: string; name: string; description: string; created_at: string; updated_at: string;
    };
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * 删除项目及其绑定的全部创作记录。
   * @param id 项目标识。
   * @returns 是否删除了项目。
   */
  deleteWorkProject(id: string): boolean {
    this.connection.exec('BEGIN');
    try {
      this.connection.prepare('DELETE FROM prompt_records WHERE project_id = ?').run(id);
      const result = this.connection.prepare('DELETE FROM projects WHERE id = ?').run(id);
      this.connection.exec('COMMIT');
      const deleted = Number(result.changes) > 0;
      if (deleted) {
        this.recordsChangedEmitter.fire();
      }
      return deleted;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  /** 校验记录所属项目存在；标识 '0' 表示未归属项目。 */
  private assertWorkProjectExists(projectId: string): void {
    if (projectId === '0') {
      return;
    }
    const project = this.connection.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      throw new Error('所选项目不存在。');
    }
  }

  /**
   * 关闭数据库连接。
   */
  dispose(): void {
    this.recordsChangedEmitter.dispose();
    this.connection.close();
  }
}

function serializeJson(value: unknown, fieldName: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`数据库记录的 ${fieldName} 必须是可序列化的 JSON 数据。`);
  }

  return json;
}

function readRecord(row: StoredPromptRecord): PromptRecord {
  return {
    id: row.id,
    title: row.title ?? undefined,
    categoryId: row.category_id,
    categoryName: row.category_name,
    projectId: row.project_id,
    schema: JSON.parse(row.schema_json) as unknown,
    data: JSON.parse(row.data_json) as unknown,
    generatedResultChinese: row.generated_result_chinese ?? undefined,
    generatedResultEnglish: row.generated_result_english ?? undefined,
    generatedResultContent: row.generated_result_content ?? undefined,
    createdAt: row.created_at,
    generatedAt: row.generated_at ?? undefined
  };
}

function migratePromptRecords(connection: DatabaseSync): void {
  connection.exec('BEGIN');
  try {
    const projectTables = connection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('projects', 'collections', 'episodes')
    `).all() as { name: string }[];
    const tableNames = new Set(projectTables.map((table) => table.name));
    if (tableNames.has('episodes') && tableNames.has('collections')) {
      throw new Error('数据库同时存在旧版项目表和新版项目表，无法安全迁移。');
    }
    if (tableNames.has('projects') && (tableNames.has('collections') || tableNames.has('episodes'))) {
      throw new Error('数据库同时存在旧项目表和新项目表，无法安全迁移。');
    }
    if (tableNames.has('episodes')) {
      connection.exec('ALTER TABLE episodes RENAME TO projects');
    } else if (tableNames.has('collections')) {
      connection.exec('ALTER TABLE collections RENAME TO projects');
    } else if (!tableNames.has('projects')) {
      connection.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    }

    const columns = connection.prepare('PRAGMA table_info(prompt_records)').all() as {
      name: string;
    }[];
    const columnNames = new Set(columns.map((column) => column.name));
    if ((columnNames.has('episode_id') || columnNames.has('collection_id')) && columnNames.has('project_id')) {
      throw new Error('数据库同时存在旧版项目关联字段和新版项目关联字段，无法安全迁移。');
    }
    if (columnNames.has('episode_id')) {
      connection.exec('ALTER TABLE prompt_records RENAME COLUMN episode_id TO project_id');
      columnNames.delete('episode_id');
      columnNames.add('project_id');
    } else if (columnNames.has('collection_id')) {
      connection.exec('ALTER TABLE prompt_records RENAME COLUMN collection_id TO project_id');
      columnNames.delete('collection_id');
      columnNames.add('project_id');
    }
    const legacyResults = columnNames.has('generated_result')
      ? connection.prepare(`
        SELECT id, generated_result FROM prompt_records
        WHERE generated_result IS NOT NULL
      `).all() as { id: string; generated_result: string }[]
      : [];

    if (!columnNames.has('title')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN title TEXT');
    }
    if (!columnNames.has('generated_at')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN generated_at TEXT');
    }
    if (!columnNames.has('project_id')) {
      connection.exec("ALTER TABLE prompt_records ADD COLUMN project_id TEXT NOT NULL DEFAULT '0'");
    }
    if (!columnNames.has('generated_result_chinese')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN generated_result_chinese TEXT');
    }
    if (!columnNames.has('generated_result_english')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN generated_result_english TEXT');
    }
    if (!columnNames.has('generated_result_content')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN generated_result_content TEXT');
    }

    connection.exec(`
      CREATE TABLE IF NOT EXISTS generated_episode_contents (
        record_id TEXT NOT NULL REFERENCES prompt_records(id) ON DELETE CASCADE,
        episode_number INTEGER NOT NULL CHECK (episode_number BETWEEN 1 AND ${MAX_GENERATED_EPISODES}),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (record_id, episode_number)
      )
    `);

    const updateResult = connection.prepare(`
      UPDATE prompt_records
      SET generated_result_chinese = ?, generated_result_english = ?
      WHERE id = ?
    `);
    for (const result of legacyResults) {
      updateResult.run(result.generated_result, null, result.id);
    }

    if (columnNames.has('generated_result')) {
      connection.exec('ALTER TABLE prompt_records DROP COLUMN generated_result');
    }

    connection.exec(`
      DROP INDEX IF EXISTS prompt_records_project_task_episode_unique_idx;
      DROP INDEX IF EXISTS prompt_records_project_episode_unique_idx;
      DROP INDEX IF EXISTS prompt_records_collection_task_episode_unique_idx;
      DROP INDEX IF EXISTS prompt_records_collection_episode_unique_idx;
    `);
    if (columnNames.has('episode_number')) {
      connection.exec('ALTER TABLE prompt_records DROP COLUMN episode_number');
    }
    const updateCategory = connection.prepare(`
      UPDATE prompt_records
      SET category_id = ?, category_name = ?
      WHERE category_id = ?
    `);
    updateCategory.run(
      'ai-video-creation-tools_collect_creative_writing_parameters',
      '创意写作',
      'ai-video-creation-tools_collect_story_parameters'
    );
    updateCategory.run(
      'ai-video-creation-tools_collect_image_inspired_writing_parameters',
      '图片灵感写作',
      'ai-video-creation-tools_collect_image_story_parameters'
    );

    connection.exec('DROP INDEX IF EXISTS prompt_records_category_updated_idx');
    if (columnNames.has('updated_at')) {
      connection.exec('ALTER TABLE prompt_records DROP COLUMN updated_at');
    }
    connection.exec(`
      UPDATE prompt_records
      SET project_id = '0'
      WHERE project_id IS NULL OR project_id = '';
    `);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

/** 判断数据库异常是否由项目名称唯一约束触发。 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
