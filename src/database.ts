import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { GeneratedChapterContent, MAX_GENERATED_CHAPTERS } from './chapterContent';

const DATABASE_SCHEMA_VERSION = 4;

/** 新增一条提示词记录及其项目归属。 */
export interface NewPromptRecord {
  readonly taskName: string;
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
  readonly taskName: string;
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
  | { readonly type: 'chapters'; readonly chapters: readonly GeneratedChapterContent[] };

/** 修改提示词记录时可更新的字段。 */
export interface UpdatedPromptRecord {
  readonly taskName: string;
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

/** 可作为剧本创作素材来源的已生成内容任务。 */
export interface GeneratedContentTask {
  readonly id: string;
  readonly taskName: string;
  readonly projectId: string;
}

/** 创建项目时需要保存的字段。 */
export interface NewWorkProject {
  readonly name: string;
  readonly description: string;
}

interface StoredPromptRecord {
  readonly id: string;
  readonly task_name: string;
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
    resetDatabaseIfOutdated(databasePath);
    deleteDatabaseFiles(legacyDatabasePath);
    const connection = new DatabaseSync(databasePath);

    try {
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec(`
        CREATE TABLE IF NOT EXISTS prompt_records (
          id TEXT PRIMARY KEY NOT NULL,
          task_name TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generated_chapter_contents (
          record_id TEXT NOT NULL REFERENCES prompt_records(id) ON DELETE CASCADE,
          chapter_number INTEGER NOT NULL CHECK (chapter_number BETWEEN 1 AND ${MAX_GENERATED_CHAPTERS}),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (record_id, chapter_number)
        );
      `);
      connection.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
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
        id, task_name, category_id, category_name, project_id, schema_json, data_json, created_at, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskName,
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

  /** 查询指定内容类工作流中已有生成结果的任务。 */
  listGeneratedContentTasks(categoryIds: readonly string[], chapterCategoryIds: readonly string[]): GeneratedContentTask[] {
    if (categoryIds.length === 0) {
      return [];
    }

    const parameters: string[] = [...categoryIds];
    const conditions = [
      `category_id IN (${categoryIds.map(() => '?').join(', ')})`,
      "((generated_result_content IS NOT NULL AND TRIM(generated_result_content) <> '')"
    ];
    if (chapterCategoryIds.length > 0) {
      conditions[1] += ` OR (category_id IN (${chapterCategoryIds.map(() => '?').join(', ')}) AND EXISTS (
        SELECT 1 FROM generated_chapter_contents chapters WHERE chapters.record_id = prompt_records.id
      ))`;
      parameters.push(...chapterCategoryIds);
    }
    conditions[1] += ')';
    const rows = this.connection.prepare(`
      SELECT id, task_name, project_id FROM prompt_records
      WHERE ${conditions.join(' AND ')} AND project_id <> '0'
      ORDER BY created_at DESC, id DESC
    `).all(...parameters) as { id: string; task_name: string; project_id: string }[];
    return rows.map((row) => ({ id: row.id, taskName: row.task_name, projectId: row.project_id }));
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
  * 更新任务名称、字段模板和数据。
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
      SET task_name = ?, project_id = ?, schema_json = ?, data_json = ?
      WHERE id = ?
    `).run(input.taskName, input.projectId, schemaJson, dataJson, id);

    if (Number(result.changes) === 0) {
      return undefined;
    }

    this.recordsChangedEmitter.fire();
    return this.getRecord(id);
  }

  /** 删除指定工作流中仍保存旧字段签名的冲突记录。 */
  deleteRecordsWithConflictingFields(categoryIds: readonly string[], fieldNames: readonly string[]): number {
    if (categoryIds.length === 0 || fieldNames.length === 0) {
      return 0;
    }

    const placeholders = categoryIds.map(() => '?').join(', ');
    const rows = this.connection.prepare(`
      SELECT id, schema_json, data_json FROM prompt_records
      WHERE category_id IN (${placeholders})
    `).all(...categoryIds) as { id: string; schema_json: string; data_json: string }[];
    const legacyNames = new Set(fieldNames);
    const conflictingIds = rows.filter((row) => {
      const data = JSON.parse(row.data_json) as unknown;
      const schema = JSON.parse(row.schema_json) as unknown;
      const hasDataField = typeof data === 'object' && data !== null && !Array.isArray(data) &&
        Object.keys(data).some((name) => legacyNames.has(name));
      const hasSchemaField = Array.isArray(schema) && schema.some((field) =>
        typeof field === 'object' && field !== null && !Array.isArray(field) &&
        'name' in field && typeof field.name === 'string' && legacyNames.has(field.name)
      );
      return hasDataField || hasSchemaField;
    }).map((row) => row.id);

    if (conflictingIds.length === 0) {
      return 0;
    }

    const deleteStatement = this.connection.prepare('DELETE FROM prompt_records WHERE id = ?');
    this.connection.exec('BEGIN');
    try {
      conflictingIds.forEach((id) => deleteStatement.run(id));
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
    this.recordsChangedEmitter.fire();
    return conflictingIds.length;
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
    const chapters = output.type === 'chapters' ? output.chapters : undefined;
    if (chapters) {
      if (chapters.length < 1 || chapters.length > MAX_GENERATED_CHAPTERS) {
        throw new Error(`章节数量必须在 1 到 ${MAX_GENERATED_CHAPTERS} 章之间。`);
      }
      chapters.forEach((chapter, index) => {
        if (chapter.chapterNumber !== index + 1 || !chapter.title.trim() || !chapter.content.trim()) {
          throw new Error('每章必须按顺序提供连续章节号、标题和正文。');
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

      this.connection.prepare('DELETE FROM generated_chapter_contents WHERE record_id = ?').run(id);
      if (chapters) {
        const insertChapter = this.connection.prepare(`
          INSERT INTO generated_chapter_contents (record_id, chapter_number, title, content, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const chapter of chapters) {
          insertChapter.run(id, chapter.chapterNumber, chapter.title.trim(), chapter.content.trim(), generatedAt);
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

  /** 查询指定创作任务已保存的章节内容。 */
  listGeneratedChapterContents(recordId: string): GeneratedChapterContent[] {
    const rows = this.connection.prepare(`
      SELECT chapter_number, title, content
      FROM generated_chapter_contents
      WHERE record_id = ?
      ORDER BY chapter_number
    `).all(recordId) as { chapter_number: number; title: string; content: string }[];

    return rows.map((row) => ({
      chapterNumber: row.chapter_number,
      title: row.title,
      content: row.content
    }));
  }

  /** 以单个事务替换指定任务的全部章节内容。 */
  saveGeneratedChapterContents(id: string, chapters: readonly GeneratedChapterContent[]): boolean {
    if (chapters.length < 1 || chapters.length > MAX_GENERATED_CHAPTERS) {
      throw new Error(`章节数量必须在 1 到 ${MAX_GENERATED_CHAPTERS} 章之间。`);
    }
    chapters.forEach((chapter, index) => {
      if (chapter.chapterNumber !== index + 1 || !chapter.title.trim() || !chapter.content.trim()) {
        throw new Error('每章必须按顺序提供连续章节号、标题和正文。');
      }
    });
    if (!this.connection.prepare('SELECT 1 FROM prompt_records WHERE id = ?').get(id)) {
      return false;
    }

    const generatedAt = new Date().toISOString();
    const insertChapter = this.connection.prepare(`
      INSERT INTO generated_chapter_contents (record_id, chapter_number, title, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.connection.exec('BEGIN');
    try {
      this.connection.prepare('DELETE FROM generated_chapter_contents WHERE record_id = ?').run(id);
      for (const chapter of chapters) {
        insertChapter.run(id, chapter.chapterNumber, chapter.title.trim(), chapter.content.trim(), generatedAt);
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
    taskName: row.task_name,
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

function resetDatabaseIfOutdated(databasePath: string): void {
  if (!existsSync(databasePath)) {
    return;
  }

  const connection = new DatabaseSync(databasePath);
  let schemaVersion: number;
  try {
    const result = connection.prepare('PRAGMA user_version').get() as { user_version: number };
    schemaVersion = result.user_version;
  } finally {
    connection.close();
  }

  if (schemaVersion !== DATABASE_SCHEMA_VERSION) {
    deleteDatabaseFiles(databasePath);
  }
}

function deleteDatabaseFiles(databasePath: string): void {
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

/** 判断数据库异常是否由项目名称唯一约束触发。 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
