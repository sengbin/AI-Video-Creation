import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

export interface NewPromptRecord {
  readonly title: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly schema: unknown;
  readonly data: unknown;
}

export interface PromptRecord {
  readonly id: string;
  readonly title: string | undefined;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly schema: unknown;
  readonly data: unknown;
  readonly generatedResultChinese: string | undefined;
  readonly generatedResultEnglish: string | undefined;
  readonly generatedResultContent: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdatedPromptRecord {
  readonly title: string;
  readonly schema: unknown;
  readonly data: unknown;
}

interface StoredPromptRecord {
  readonly id: string;
  readonly title: string | null;
  readonly category_id: string;
  readonly category_name: string;
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
   * 保存分类、字段模板快照和表单数据。
   * @param input 要保存的记录内容。
   */
  saveRecord(input: NewPromptRecord): PromptRecord {
    const record = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const schemaJson = serializeJson(record.schema, 'schema');
    const dataJson = serializeJson(record.data, 'data');

    this.connection.prepare(`
      INSERT INTO prompt_records (
        id, title, category_id, category_name, schema_json, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.title,
      record.categoryId,
      record.categoryName,
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
   * 查询记录，可按分类标识筛选。
   * @param categoryId 分类标识；不传时查询全部记录。
   */
  listRecords(categoryId?: string): PromptRecord[] {
    const rows = categoryId === undefined
      ? this.connection.prepare(`
        SELECT * FROM prompt_records ORDER BY created_at DESC, id DESC
      `).all()
      : this.connection.prepare(`
        SELECT * FROM prompt_records
        WHERE category_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(categoryId);

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
    const schemaJson = serializeJson(input.schema, 'schema');
    const dataJson = serializeJson(input.data, 'data');
    const updatedAt = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE prompt_records
      SET title = ?, schema_json = ?, data_json = ?, updated_at = ?
      WHERE id = ?
    `).run(input.title, schemaJson, dataJson, updatedAt, id);

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
      CREATE INDEX IF NOT EXISTS prompt_records_category_updated_idx
        ON prompt_records (category_id, updated_at DESC);
    `);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}
