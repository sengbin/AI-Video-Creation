import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

/** 新增一条提示词记录及其剧集归属。 */
export interface NewPromptRecord {
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string;
  /** 剧集标识；缺省或 '0' 表示不归属剧集。 */
  readonly episodeId?: string;
  readonly schema: unknown;
  readonly data: unknown;
}

/** 数据库中的完整提示词记录。 */
export interface PromptRecord {
  readonly id: string;
  readonly title: string | undefined;
  readonly categoryId: string;
  readonly categoryName: string;
  /** 剧集标识；'0' 表示不归属剧集。 */
  readonly episodeId: string;
  readonly schema: unknown;
  readonly data: unknown;
  readonly generatedResultChinese: string | undefined;
  readonly generatedResultEnglish: string | undefined;
  readonly generatedResultContent: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 修改提示词记录时可更新的字段。 */
export interface UpdatedPromptRecord {
  readonly title: string;
  /** 新剧集标识；'0' 表示不归属剧集。 */
  readonly episodeId: string;
  readonly schema: unknown;
  readonly data: unknown;
}

/** 表示剧集管理列表中的一条剧集。 */
export interface Episode {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建剧集时需要保存的字段。 */
export interface NewEpisode {
  readonly name: string;
  readonly description: string;
}

interface StoredPromptRecord {
  readonly id: string;
  readonly title: string | null;
  readonly category_id: string;
  readonly category_name: string;
  readonly episode_id: string;
  readonly schema_json: string;
  readonly data_json: string;
  readonly generated_result_chinese: string | null;
  readonly generated_result_english: string | null;
  readonly generated_result_content: string | null;
  readonly created_at: string;
  readonly updated_at: string;
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

    const connection = new DatabaseSync(
      vscode.Uri.joinPath(storageUri, 'prompt-records.sqlite').fsPath
    );

    try {
      connection.exec(`
        CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_records (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT,
          category_id TEXT NOT NULL,
          category_name TEXT NOT NULL,
          episode_id TEXT NOT NULL DEFAULT '0',
          schema_json TEXT NOT NULL,
          data_json TEXT NOT NULL,
          generated_result_chinese TEXT,
          generated_result_english TEXT,
          generated_result_content TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT
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
  * 保存分类、剧集归属、字段模板快照和表单数据。
   * @param input 要保存的记录内容。
   */
  saveRecord(input: NewPromptRecord): PromptRecord {
    const episodeId = input.episodeId ?? '0';
    this.assertEpisodeExists(episodeId);
    const record = {
      ...input,
      episodeId,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const schemaJson = serializeJson(record.schema, 'schema');
    const dataJson = serializeJson(record.data, 'data');

    this.connection.prepare(`
      INSERT INTO prompt_records (
        id, title, category_id, category_name, episode_id, schema_json, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.title,
      record.categoryId,
      record.categoryName,
      record.episodeId,
      schemaJson,
      dataJson,
      record.createdAt,
      record.createdAt
    );

    this.recordsChangedEmitter.fire();
    return {
      ...record,
      generatedResultChinese: undefined,
      generatedResultEnglish: undefined,
      generatedResultContent: undefined,
      updatedAt: record.createdAt
    };
  }

  /**
   * 查询记录，可按分类标识和剧集筛选。
   * @param categoryId 分类标识；不传时查询全部记录。
   * @param episodeId 剧集标识；'0' 表示未归属剧集，不传时不按剧集筛选。
   */
  listRecords(categoryId?: string, episodeId?: string): PromptRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (categoryId !== undefined) {
      conditions.push('category_id = ?');
      parameters.push(categoryId);
    }
    if (episodeId !== undefined) {
      conditions.push('episode_id = ?');
      parameters.push(episodeId);
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
    this.assertEpisodeExists(input.episodeId);
    const schemaJson = serializeJson(input.schema, 'schema');
    const dataJson = serializeJson(input.data, 'data');
    const updatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET title = ?, episode_id = ?, schema_json = ?, data_json = ?, updated_at = ?
      WHERE id = ?
    `).run(input.title, input.episodeId, schemaJson, dataJson, updatedAt, id);

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
    const updatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET generated_result_chinese = ?, generated_result_english = ?, updated_at = ?
      WHERE id = ?
    `).run(contentZh, contentEn, updatedAt, id);

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
    const updatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET generated_result_content = ?, updated_at = ?
      WHERE id = ?
    `).run(content, updatedAt, id);

    if (Number(result.changes) === 0) {
      return undefined;
    }

    this.recordsChangedEmitter.fire();
    return this.getRecord(id);
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
   * 返回按创建时间排序的全部剧集。
   * @returns 剧集列表。
   */
  listEpisodes(): Episode[] {
    const rows = this.connection.prepare(`
      SELECT id, name, description, created_at, updated_at
      FROM episodes ORDER BY created_at DESC, id DESC
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
   * 创建一个剧集。
   * @param input 剧集名称和描述。
   * @returns 已保存的剧集。
   * @throws 名称为空或与现有剧集重复时抛出错误。
   */
  createEpisode(input: NewEpisode): Episode {
    const name = input.name.trim();
    if (!name) {
      throw new Error('剧集名称不能为空。');
    }
    const episode = {
      id: randomUUID(),
      name,
      description: input.description,
      createdAt: new Date().toISOString()
    };
    try {
      this.connection.prepare(`
        INSERT INTO episodes (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(episode.id, episode.name, episode.description, episode.createdAt, episode.createdAt);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error('剧集名称已存在。');
      }
      throw error;
    }
    this.recordsChangedEmitter.fire();
    return { ...episode, updatedAt: episode.createdAt };
  }

  /**
   * 更新剧集名称和描述。
   * @param id 剧集标识。
   * @param input 更新后的剧集名称和描述。
   * @returns 更新后的剧集；不存在时返回 undefined。
   */
  updateEpisode(id: string, input: NewEpisode): Episode | undefined {
    const name = input.name.trim();
    if (!name) {
      throw new Error('剧集名称不能为空。');
    }
    const updatedAt = new Date().toISOString();
    try {
      const result = this.connection.prepare(`
        UPDATE episodes SET name = ?, description = ?, updated_at = ? WHERE id = ?
      `).run(name, input.description, updatedAt, id);
      if (Number(result.changes) === 0) {
        return undefined;
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error('剧集名称已存在。');
      }
      throw error;
    }
    this.recordsChangedEmitter.fire();
    const row = this.connection.prepare(`
      SELECT id, name, description, created_at, updated_at FROM episodes WHERE id = ?
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
   * 删除剧集及其绑定的全部创作记录。
   * @param id 剧集标识。
   * @returns 是否删除了剧集。
   */
  deleteEpisode(id: string): boolean {
    this.connection.exec('BEGIN');
    try {
      this.connection.prepare('DELETE FROM prompt_records WHERE episode_id = ?').run(id);
      const result = this.connection.prepare('DELETE FROM episodes WHERE id = ?').run(id);
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

  /** 校验记录所属剧集存在；标识 '0' 表示不归属剧集。 */
  private assertEpisodeExists(episodeId: string): void {
    if (episodeId === '0') {
      return;
    }
    const episode = this.connection.prepare('SELECT 1 FROM episodes WHERE id = ?').get(episodeId);
    if (!episode) {
      throw new Error('所选剧集不存在。');
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
    episodeId: row.episode_id,
    schema: JSON.parse(row.schema_json) as unknown,
    data: JSON.parse(row.data_json) as unknown,
    generatedResultChinese: row.generated_result_chinese ?? undefined,
    generatedResultEnglish: row.generated_result_english ?? undefined,
    generatedResultContent: row.generated_result_content ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function migratePromptRecords(connection: DatabaseSync): void {
  connection.exec('BEGIN');
  try {
    const columns = connection.prepare('PRAGMA table_info(prompt_records)').all() as {
      name: string;
    }[];
    const columnNames = new Set(columns.map((column) => column.name));
    const legacyResults = columnNames.has('generated_result')
      ? connection.prepare(`
        SELECT id, generated_result FROM prompt_records
        WHERE generated_result IS NOT NULL
      `).all() as { id: string; generated_result: string }[]
      : [];

    if (!columnNames.has('title')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN title TEXT');
    }
    if (!columnNames.has('updated_at')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN updated_at TEXT');
    }
    if (!columnNames.has('episode_id')) {
      connection.exec("ALTER TABLE prompt_records ADD COLUMN episode_id TEXT NOT NULL DEFAULT '0'");
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
      UPDATE prompt_records
      SET updated_at = created_at
      WHERE updated_at IS NULL;
      UPDATE prompt_records
      SET episode_id = '0'
      WHERE episode_id IS NULL OR episode_id = '';
      CREATE INDEX IF NOT EXISTS prompt_records_category_updated_idx
        ON prompt_records (category_id, updated_at DESC);
    `);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

/** 判断数据库异常是否由剧集名称唯一约束触发。 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
