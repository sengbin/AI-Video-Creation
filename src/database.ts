import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

/** 新增一条提示词记录及其合集归属。 */
export interface NewPromptRecord {
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string;
  /** 合集标识；缺省或 '0' 表示未归属合集。 */
  readonly collectionId?: string;
  /** 记录所属合集中的集数。 */
  readonly episodeNumber?: number;
  readonly schema: unknown;
  readonly data: unknown;
}

/** 数据库中的完整提示词记录。 */
export interface PromptRecord {
  readonly id: string;
  readonly title: string | undefined;
  readonly categoryId: string;
  readonly categoryName: string;
  /** 合集标识；'0' 表示未归属合集。 */
  readonly collectionId: string;
  readonly episodeNumber: number | undefined;
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
  /** 新合集标识；'0' 表示未归属合集。 */
  readonly collectionId: string;
  /** 更新后的集数。 */
  readonly episodeNumber?: number;
  readonly schema: unknown;
  readonly data: unknown;
}

/** 表示合集管理列表中的一条合集。 */
export interface WorkCollection {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 表示合集内已占用集数的任务记录。 */
export interface EpisodeNumberRecord {
  readonly id: string;
  readonly title: string | undefined;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly collectionId: string;
  readonly collectionName: string;
  readonly episodeNumber: number;
}

/** 创建合集时需要保存的字段。 */
export interface NewWorkCollection {
  readonly name: string;
  readonly description: string;
}

interface StoredPromptRecord {
  readonly id: string;
  readonly title: string | null;
  readonly category_id: string;
  readonly category_name: string;
  readonly collection_id: string;
  readonly episode_number: number | null;
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
        CREATE TABLE IF NOT EXISTS prompt_records (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT,
          category_id TEXT NOT NULL,
          category_name TEXT NOT NULL,
          collection_id TEXT NOT NULL DEFAULT '0',
          episode_number INTEGER,
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
  * 保存分类、合集归属、字段模板快照和表单数据。
   * @param input 要保存的记录内容。
   */
  saveRecord(input: NewPromptRecord): PromptRecord {
    const collectionId = input.collectionId ?? '0';
    this.assertWorkCollectionExists(collectionId);
    this.assertEpisodeNumberValid(input.episodeNumber);
    this.assertEpisodeNumberAvailable(collectionId, input.categoryId, input.episodeNumber);
    const record = {
      ...input,
      collectionId,
      episodeNumber: input.episodeNumber,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const schemaJson = serializeJson(record.schema, 'schema');
    const dataJson = serializeJson(record.data, 'data');

    this.connection.prepare(`
      INSERT INTO prompt_records (
        id, title, category_id, category_name, collection_id, episode_number, schema_json, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.title,
      record.categoryId,
      record.categoryName,
      record.collectionId,
      record.episodeNumber ?? null,
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
   * 查询记录，可按分类标识和合集筛选。
   * @param categoryId 分类标识；不传时查询全部记录。
   * @param collectionId 合集标识；'0' 表示未归属合集，不传时不按合集筛选。
   */
  listRecords(categoryId?: string, collectionId?: string): PromptRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (categoryId !== undefined) {
      conditions.push('category_id = ?');
      parameters.push(categoryId);
    }
    if (collectionId !== undefined) {
      conditions.push('collection_id = ?');
      parameters.push(collectionId);
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

  /** 查询已绑定合集的集数记录，用于表单即时校验。 */
  listEpisodeNumberRecords(): EpisodeNumberRecord[] {
    const rows = this.connection.prepare(`
      SELECT records.id, records.title, records.category_id, records.category_name, records.collection_id,
        collections.name AS collection_name, records.episode_number
      FROM prompt_records AS records
      INNER JOIN collections ON collections.id = records.collection_id
      WHERE records.episode_number IS NOT NULL
      ORDER BY records.collection_id, records.episode_number
    `).all() as {
      id: string;
      title: string | null;
      category_id: string;
      category_name: string;
      collection_id: string;
      collection_name: string;
      episode_number: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? undefined,
      categoryId: row.category_id,
      categoryName: row.category_name,
      collectionId: row.collection_id,
      collectionName: row.collection_name,
      episodeNumber: row.episode_number
    }));
  }

  /** 查询指定合集和集数的冲突记录，可排除正在编辑的记录。 */
  findEpisodeNumberConflict(
    collectionId: string,
    categoryId: string,
    episodeNumber: number,
    excludeRecordId?: string
  ): EpisodeNumberRecord | undefined {
    if (collectionId === '0') {
      return undefined;
    }
    const row = this.connection.prepare(`
      SELECT records.id, records.title, records.category_id, records.category_name, records.collection_id,
        collections.name AS collection_name, records.episode_number
      FROM prompt_records AS records
      INNER JOIN collections ON collections.id = records.collection_id
      WHERE records.collection_id = ? AND records.category_id = ? AND records.episode_number = ?
        AND (? IS NULL OR records.id <> ?)
      LIMIT 1
    `).get(collectionId, categoryId, episodeNumber, excludeRecordId ?? null, excludeRecordId ?? null) as {
      id: string;
      title: string | null;
      category_id: string;
      category_name: string;
      collection_id: string;
      collection_name: string;
      episode_number: number;
    } | undefined;

    return row ? {
      id: row.id,
      title: row.title ?? undefined,
      categoryId: row.category_id,
      categoryName: row.category_name,
      collectionId: row.collection_id,
      collectionName: row.collection_name,
      episodeNumber: row.episode_number
    } : undefined;
  }

  /**
   * 更新记录标题、字段模板和数据。
   * @param id 记录标识。
   * @param input 更新后的记录内容。
   * @returns 更新后的记录；记录不存在时返回 undefined。
   */
  updateRecord(id: string, input: UpdatedPromptRecord): PromptRecord | undefined {
    this.assertWorkCollectionExists(input.collectionId);
    this.assertEpisodeNumberValid(input.episodeNumber);
    const existingRecord = this.getRecord(id);
    if (existingRecord) {
      this.assertEpisodeNumberAvailable(input.collectionId, existingRecord.categoryId, input.episodeNumber, id);
    }
    const schemaJson = serializeJson(input.schema, 'schema');
    const dataJson = serializeJson(input.data, 'data');
    const updatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET title = ?, collection_id = ?, episode_number = ?, schema_json = ?, data_json = ?, updated_at = ?
      WHERE id = ?
    `).run(input.title, input.collectionId, input.episodeNumber ?? null, schemaJson, dataJson, updatedAt, id);

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
   * 返回按创建时间排序的全部合集。
   * @returns 合集列表。
   */
  listWorkCollections(): WorkCollection[] {
    const rows = this.connection.prepare(`
      SELECT id, name, description, created_at, updated_at
      FROM collections ORDER BY created_at DESC, id DESC
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
   * 创建一个合集。
   * @param input 合集名称和描述。
   * @returns 已保存的合集。
   * @throws 名称为空或与现有合集重复时抛出错误。
   */
  createWorkCollection(input: NewWorkCollection): WorkCollection {
    const name = input.name.trim();
    if (!name) {
      throw new Error('合集名称不能为空。');
    }
    const collection = {
      id: randomUUID(),
      name,
      description: input.description,
      createdAt: new Date().toISOString()
    };
    try {
      this.connection.prepare(`
        INSERT INTO collections (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(collection.id, collection.name, collection.description, collection.createdAt, collection.createdAt);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error('合集名称已存在。');
      }
      throw error;
    }
    this.recordsChangedEmitter.fire();
    return { ...collection, updatedAt: collection.createdAt };
  }

  /**
   * 更新合集名称和描述。
   * @param id 合集标识。
   * @param input 更新后的合集名称和描述。
   * @returns 更新后的合集；不存在时返回 undefined。
   */
  updateWorkCollection(id: string, input: NewWorkCollection): WorkCollection | undefined {
    const name = input.name.trim();
    if (!name) {
      throw new Error('合集名称不能为空。');
    }
    const updatedAt = new Date().toISOString();
    try {
      const result = this.connection.prepare(`
        UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?
      `).run(name, input.description, updatedAt, id);
      if (Number(result.changes) === 0) {
        return undefined;
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error('合集名称已存在。');
      }
      throw error;
    }
    this.recordsChangedEmitter.fire();
    const row = this.connection.prepare(`
      SELECT id, name, description, created_at, updated_at FROM collections WHERE id = ?
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
   * 删除合集及其绑定的全部创作记录。
   * @param id 合集标识。
   * @returns 是否删除了合集。
   */
  deleteWorkCollection(id: string): boolean {
    this.connection.exec('BEGIN');
    try {
      this.connection.prepare('DELETE FROM prompt_records WHERE collection_id = ?').run(id);
      const result = this.connection.prepare('DELETE FROM collections WHERE id = ?').run(id);
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

  /** 校验记录所属合集存在；标识 '0' 表示未归属合集。 */
  private assertWorkCollectionExists(collectionId: string): void {
    if (collectionId === '0') {
      return;
    }
    const collection = this.connection.prepare('SELECT 1 FROM collections WHERE id = ?').get(collectionId);
    if (!collection) {
      throw new Error('所选合集不存在。');
    }
  }

  /** 确保已填写的集数为正安全整数。 */
  private assertEpisodeNumberValid(episodeNumber: number | undefined): void {
    if (episodeNumber !== undefined && (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1)) {
      throw new Error('集数必须是大于或等于 1 的整数。');
    }
  }

  /** 阻止同一合集内的任务重复占用集数。 */
  private assertEpisodeNumberAvailable(
    collectionId: string,
    categoryId: string,
    episodeNumber: number | undefined,
    excludeRecordId?: string
  ): void {
    if (episodeNumber === undefined) {
      return;
    }
    const conflict = this.findEpisodeNumberConflict(collectionId, categoryId, episodeNumber, excludeRecordId);
    if (conflict) {
      throw new Error(
        `合集“${conflict.collectionName}”的第 ${episodeNumber} 集已被同类任务“${conflict.title ?? '未命名任务'}”（${conflict.categoryName}）占用。请更改集数或选择其他合集。`
      );
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
    collectionId: row.collection_id,
    episodeNumber: row.episode_number ?? undefined,
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
    const collectionTables = connection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('collections', 'episodes')
    `).all() as { name: string }[];
    const tableNames = new Set(collectionTables.map((table) => table.name));
    if (tableNames.has('episodes') && tableNames.has('collections')) {
      throw new Error('数据库同时存在旧版合集表和新版合集表，无法安全迁移。');
    }
    if (tableNames.has('episodes')) {
      connection.exec('ALTER TABLE episodes RENAME TO collections');
    } else if (!tableNames.has('collections')) {
      connection.exec(`
        CREATE TABLE collections (
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
    if (columnNames.has('episode_id') && columnNames.has('collection_id')) {
      throw new Error('数据库同时存在旧版合集关联字段和新版合集关联字段，无法安全迁移。');
    }
    if (columnNames.has('episode_id')) {
      connection.exec('ALTER TABLE prompt_records RENAME COLUMN episode_id TO collection_id');
      columnNames.delete('episode_id');
      columnNames.add('collection_id');
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
    if (!columnNames.has('updated_at')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN updated_at TEXT');
    }
    if (!columnNames.has('collection_id')) {
      connection.exec("ALTER TABLE prompt_records ADD COLUMN collection_id TEXT NOT NULL DEFAULT '0'");
    }
    if (!columnNames.has('episode_number')) {
      connection.exec('ALTER TABLE prompt_records ADD COLUMN episode_number INTEGER');
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

    connection.exec('DROP INDEX IF EXISTS prompt_records_collection_task_episode_unique_idx');
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

    connection.exec(`
      UPDATE prompt_records
      SET updated_at = created_at
      WHERE updated_at IS NULL;
      UPDATE prompt_records
      SET collection_id = '0'
      WHERE collection_id IS NULL OR collection_id = '';
      CREATE INDEX IF NOT EXISTS prompt_records_category_updated_idx
        ON prompt_records (category_id, updated_at DESC);
      DROP INDEX IF EXISTS prompt_records_collection_episode_unique_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS prompt_records_collection_task_episode_unique_idx
        ON prompt_records (collection_id, category_id, episode_number)
        WHERE collection_id <> '0' AND episode_number IS NOT NULL;
    `);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

/** 判断数据库异常是否由合集名称唯一约束触发。 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
