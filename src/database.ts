import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

export interface NewPromptRecord {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly schema: unknown;
  readonly data: unknown;
}

export interface PromptRecord extends NewPromptRecord {
  readonly id: string;
  readonly createdAt: string;
}

interface StoredPromptRecord {
  readonly id: string;
  readonly category_id: string;
  readonly category_name: string;
  readonly schema_json: string;
  readonly data_json: string;
  readonly created_at: string;
}

/**
 * 管理扩展用户级提示词记录数据库。
 */
export class PromptDatabase implements vscode.Disposable {
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
          category_id TEXT NOT NULL,
          category_name TEXT NOT NULL,
          schema_json TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS prompt_records_category_created_idx
          ON prompt_records (category_id, created_at DESC);
      `);
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
    const record: PromptRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const schemaJson = serializeJson(record.schema, 'schema');
    const dataJson = serializeJson(record.data, 'data');

    this.connection.prepare(`
      INSERT INTO prompt_records (
        id, category_id, category_name, schema_json, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.categoryId,
      record.categoryName,
      schemaJson,
      dataJson,
      record.createdAt
    );

    return record;
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
   * 按记录标识删除记录。
   * @param id 记录标识。
   * @returns 是否删除了记录。
   */
  deleteRecord(id: string): boolean {
    const result = this.connection.prepare(`
      DELETE FROM prompt_records WHERE id = ?
    `).run(id);

    return Number(result.changes) > 0;
  }

  /**
   * 关闭数据库连接。
   */
  dispose(): void {
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
    categoryId: row.category_id,
    categoryName: row.category_name,
    schema: JSON.parse(row.schema_json) as unknown,
    data: JSON.parse(row.data_json) as unknown,
    createdAt: row.created_at
  };
}