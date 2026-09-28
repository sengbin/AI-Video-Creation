import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { PromptDatabase } from '../../database';
import {
  parseImageAttachments,
  renderAddRecordFields,
  validateWorkflowFormValues
} from '../../formPanel';
import {
  formWorkflows,
  CREATIVE_WRITING_WORKFLOW_NAME,
  IMAGE_ATTACHMENTS_FIELD,
  IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
  SCREENPLAY_WORKFLOW_NAME,
  SHOOTING_SCRIPT_WORKFLOW_NAME
} from '../../formWorkflows';
import {
  GeneratedResultTool,
  SAVE_GENERATED_RESULT_TOOL_NAME,
  WorkflowFormTool,
  WorkflowSubmissionStore
} from '../../workflowFormTool';

suite('AI视频创作助手扩展', () => {
  test('剧本表单要求项目并只列出已有生成内容的项目任务', async () => {
    const workflow = formWorkflows.find((item) => item.toolName === SCREENPLAY_WORKFLOW_NAME);
    assert.ok(workflow);
    assert.strictEqual(workflow.requiresProject, true);
    assert.ok(!workflow.fields.some((field) => field.name === 'format' || field.name === 'duration'));
    assert.ok(workflow.fields.some((field) => field.name === 'maxEpisodeDurationSeconds' && field.required));
    assert.ok(!workflow.fields.some((field) => field.name === 'episodeDurationSeconds'));
    assert.ok(workflow.fields.some((field) => field.name === 'maxEpisodes' && field.required));
    assert.ok(workflow.fields.some((field) => field.name === 'genre' && field.allowCustom));
    assert.ok(workflow.fields.some((field) => field.name === 'style' && field.allowCustom));

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-screenplay-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    try {
      const project = database.createWorkProject({ name: '剧本项目', description: '' });
      const task = database.saveRecord({
        title: '故事创意',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        projectId: project.id,
        schema: [{ name: 'title' }],
        data: { title: '故事创意' }
      });
      database.updateGeneratedContent(task.id, '完整生成正文');
      database.saveRecord({
        title: '尚未生成的任务',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        projectId: project.id,
        schema: [{ name: 'title' }],
        data: { title: '尚未生成的任务' }
      });

      const tasks = database.listGeneratedContentTasks([CREATIVE_WRITING_WORKFLOW_NAME], []);
      assert.deepStrictEqual(tasks.map((item) => item.id), [task.id]);
      const html = renderAddRecordFields(workflow, [project], {}, tasks);
      assert.ok(!html.includes('未归属项目'));
      assert.ok(html.includes('name="projectId" required'));
      assert.ok(html.includes(`value="${task.id}" data-project-id="${project.id}"`));
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('列表添加对话框渲染任务字段并复用工作流校验', () => {
    const workflow = formWorkflows.find((item) => item.toolName === CREATIVE_WRITING_WORKFLOW_NAME);
    const imageWorkflow = formWorkflows.find((item) => item.toolName === IMAGE_INSPIRED_WRITING_WORKFLOW_NAME);
    assert.ok(workflow);
    assert.ok(imageWorkflow);

    const project = {
      id: 'project-id',
      name: '<项目>',
      description: '',
      createdAt: '',
      updatedAt: ''
    };
    const html = renderAddRecordFields(workflow, [project]);
    assert.ok(html.includes('name="projectId"'));
    assert.ok(html.includes('&lt;项目&gt;'));
    assert.ok(html.includes('name="title"'));
    assert.ok(html.includes('name="chapterMinWords"'));
    assert.ok(html.includes('name="chapterMaxWords"'));
    assert.ok(html.includes('name="maxChapters"'));
    assert.ok(/name="chapterMinWords"[^>]*value="200"/.test(html));
    assert.ok(/name="chapterMaxWords"[^>]*value="2500"/.test(html));
    assert.ok(/name="maxChapters"[^>]*value="20"/.test(html));

    const editHtml = renderAddRecordFields(workflow, [project], {
      title: '预填任务',
      idea: '已保存的灵感',
      projectId: project.id
    });
    assert.ok(editHtml.includes('<option value="project-id" selected>&lt;项目&gt;</option>'));
    assert.ok(editHtml.includes('>预填任务</textarea>'));
    assert.ok(editHtml.includes('>已保存的灵感</textarea>'));

    const values = Object.fromEntries(workflow.fields.map((field) => [
      field.name,
      field.name === 'title' ? '列表新增任务' :
        field.name === 'chapterMinWords' ? '200' :
          field.name === 'chapterMaxWords' ? '2500' :
            field.name === 'maxChapters' ? '20' : field.required ? '1' : ''
    ]));
    assert.deepStrictEqual(validateWorkflowFormValues(values, workflow), values);
    assert.strictEqual(
      validateWorkflowFormValues({ ...values, chapterMinWords: '2500', chapterMaxWords: '1500' }, workflow),
      undefined
    );
    assert.strictEqual(
      validateWorkflowFormValues({ ...values, title: '' }, workflow),
      undefined
    );

    const imageHtml = renderAddRecordFields(imageWorkflow, []);
    assert.ok(imageHtml.includes('id="add-image-file-input"'));
    assert.ok(imageHtml.includes(`name="${IMAGE_ATTACHMENTS_FIELD}"`));
    const imageEditHtml = renderAddRecordFields(imageWorkflow, [], {
      title: '保留图片的记录',
      [IMAGE_ATTACHMENTS_FIELD]: '[{"mimeType":"image/png","data":"aGVsbG8="}]'
    });
    assert.ok(imageEditHtml.includes('value="[{&quot;mimeType&quot;:&quot;image/png&quot;,&quot;data&quot;:&quot;aGVsbG8=&quot;}]"'));
  });

  test('首次打开时创建用户级数据库并保存动态模板记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-db-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    let database = await PromptDatabase.open(vscode.Uri.file(storagePath));

    try {
      const record = database.saveRecord({
        title: '示例记录',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        schema: [
          { name: 'title', label: '标题', required: true },
          { name: 'genre', label: '题材' }
        ],
        data: { title: '示例记录', genre: '科幻' }
      });

      assert.ok(fs.existsSync(path.join(storagePath, 'creative-projects.sqlite')));
      assert.ok(!fs.existsSync(path.join(storagePath, 'prompt-records.sqlite')));
      assert.deepStrictEqual(database.getRecord(record.id), record);
      assert.strictEqual(record.generatedAt, undefined);
      assert.deepStrictEqual(
        database.listRecords(CREATIVE_WRITING_WORKFLOW_NAME),
        [record]
      );
      assert.deepStrictEqual(
        database.listRecords('ai-video-creation-tools_collect_novel_parameters'),
        []
      );

      database.dispose();
      database = await PromptDatabase.open(vscode.Uri.file(storagePath));
      assert.deepStrictEqual(database.getRecord(record.id), record);
      const savedResult = database.updateGeneratedResult(record.id, '中文提示词正文', 'English prompt body');
      assert.strictEqual(savedResult?.generatedResultChinese, '中文提示词正文');
      assert.strictEqual(savedResult?.generatedResultEnglish, 'English prompt body');
      assert.ok(savedResult?.generatedAt);
      const updatedRecord = database.updateRecord(record.id, {
        title: '修改后的记录',
        projectId: record.projectId,
        schema: record.schema,
        data: { title: '修改后的记录', genre: '奇幻' }
      });
      assert.ok(updatedRecord);
      assert.strictEqual(updatedRecord.title, '修改后的记录');
      assert.strictEqual(updatedRecord.generatedResultChinese, '中文提示词正文');
      assert.strictEqual(updatedRecord.generatedResultEnglish, 'English prompt body');
      assert.strictEqual(updatedRecord.createdAt, record.createdAt);
      assert.deepStrictEqual(updatedRecord.data, { title: '修改后的记录', genre: '奇幻' });
      assert.strictEqual(database.deleteRecord(record.id), true);
      assert.strictEqual(database.getRecord(record.id), undefined);
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('清理旧篇幅参数冲突记录但保留其他记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-chapter-cleanup-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const legacyRecord = database.saveRecord({
      title: '旧写作记录',
      categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
      categoryName: '创意写作',
      schema: [{ name: 'episodeDurationSeconds' }, { name: 'maxEpisodes' }],
      data: { title: '旧写作记录', episodeDurationSeconds: '30', maxEpisodes: '10' }
    });
    const unrelatedRecord = database.saveRecord({
      title: '其他记录',
      categoryId: 'other-workflow',
      categoryName: '其他',
      schema: [{ name: 'maxEpisodes' }],
      data: { title: '其他记录', maxEpisodes: '10' }
    });

    try {
      const deletedCount = database.deleteRecordsWithConflictingFields(
        [CREATIVE_WRITING_WORKFLOW_NAME, IMAGE_INSPIRED_WRITING_WORKFLOW_NAME, 'ai-video-creation-tools_collect_novel_parameters'],
        ['episodeDurationSeconds', 'maxEpisodes']
      );
      assert.strictEqual(deletedCount, 1);
      assert.strictEqual(database.getRecord(legacyRecord.id), undefined);
      assert.ok(database.getRecord(unrelatedRecord.id));
      const connection = new DatabaseSync(path.join(temporaryDirectory, 'globalStorage', 'creative-projects.sqlite'));
      try {
        const chapterColumns = connection.prepare('PRAGMA table_info(generated_chapter_contents)').all() as { name: string }[];
        const legacyTable = connection.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generated_episode_contents'
        `).get();
        assert.ok(chapterColumns.some((column) => column.name === 'chapter_number'));
        assert.strictEqual(legacyTable, undefined);
      } finally {
        connection.close();
      }
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('项目可筛选记录并在删除时级联清理绑定数据', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-projects-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    try {
      const project = database.createWorkProject({ name: '短片主题', description: '同一主题下的作品集合' });
      const boundRecord = database.saveRecord({
        title: '项目记录',
        categoryId: 'story',
        categoryName: '文字作品',
        projectId: project.id,
        schema: [],
        data: { title: '项目记录' }
      });
      const unassignedRecord = database.saveRecord({
        title: '独立记录',
        categoryId: 'story',
        categoryName: '文字作品',
        projectId: '0',
        schema: [],
        data: { title: '独立记录' }
      });

      assert.strictEqual(boundRecord.projectId, project.id);
      assert.deepStrictEqual(database.listRecords(undefined, project.id), [boundRecord]);
      assert.deepStrictEqual(database.listRecords(undefined, '0'), [unassignedRecord]);
      assert.throws(() => database.createWorkProject({ name: '短片主题', description: '' }), /名称已存在/);
      assert.strictEqual(database.deleteWorkProject(project.id), true);
      assert.strictEqual(database.getRecord(boundRecord.id), undefined);
      assert.deepStrictEqual(database.listRecords(undefined, '0'), [unassignedRecord]);
      assert.deepStrictEqual(database.listWorkProjects(), []);
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('项目任务不绑定章节数且允许同类记录共存，作品章节编号保存在独立表中', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-project-records-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    const database = await PromptDatabase.open(vscode.Uri.file(storagePath));
    try {
      const project = database.createWorkProject({ name: '短片项目', description: '' });
      const firstRecord = database.saveRecord({
        title: '相遇',
        categoryId: 'story',
        categoryName: '创意写作',
        projectId: project.id,
        schema: [],
        data: { title: '相遇' }
      });
      const duplicateCategoryRecord = database.saveRecord({
        title: '相遇的另一个版本',
        categoryId: 'story',
        categoryName: '创意写作',
        projectId: project.id,
        schema: [],
        data: { title: '相遇的另一个版本' }
      });

      assert.deepStrictEqual(database.listRecords('story', project.id), [duplicateCategoryRecord, firstRecord]);

      const connection = new DatabaseSync(path.join(storagePath, 'creative-projects.sqlite'));
      try {
        const taskColumns = connection.prepare('PRAGMA table_info(prompt_records)').all() as { name: string }[];
        const chapterColumns = connection.prepare('PRAGMA table_info(generated_chapter_contents)').all() as { name: string }[];
        assert.ok(!taskColumns.some((column) => column.name === 'chapter_number'));
        assert.ok(chapterColumns.some((column) => column.name === 'chapter_number'));
      } finally {
        connection.close();
      }
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('图片附件会随记录保存并在重新打开数据库后恢复', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-image-record-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    let database = await PromptDatabase.open(vscode.Uri.file(storagePath));
    const workflow = formWorkflows.find((item) => item.supportsImageAttachments);
    assert.ok(workflow);
    const attachment = {
      mimeType: 'image/png' as const,
      data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]).toString('base64')
    };
    const record = database.saveRecord({
      title: '含图片的创作记录',
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      schema: workflow.fields,
      data: {
        title: '含图片的创作记录',
        [IMAGE_ATTACHMENTS_FIELD]: JSON.stringify([attachment])
      }
    });

    try {
      database.dispose();
      database = await PromptDatabase.open(vscode.Uri.file(storagePath));
      const restoredRecord = database.getRecord(record.id);
      assert.ok(restoredRecord);
      const restoredValues = restoredRecord.data as Record<string, unknown>;
      assert.strictEqual(typeof restoredValues[IMAGE_ATTACHMENTS_FIELD], 'string');
      assert.deepStrictEqual(
        parseImageAttachments(restoredValues[IMAGE_ATTACHMENTS_FIELD] as string),
        [attachment]
      );

      const updatedRecord = database.updateRecord(record.id, {
        title: '编辑后的图片创作记录',
        projectId: record.projectId,
        schema: workflow.fields,
        data: { ...restoredValues, title: '编辑后的图片创作记录' }
      });
      assert.ok(updatedRecord);
      assert.deepStrictEqual(
        parseImageAttachments((updatedRecord.data as Record<string, unknown>)[IMAGE_ATTACHMENTS_FIELD] as string),
        [attachment]
      );
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够迁移旧数据库并保留已有记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-db-migration-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    fs.mkdirSync(storagePath);
    const legacyConnection = new DatabaseSync(path.join(storagePath, 'prompt-records.sqlite'));
    legacyConnection.exec(`
      CREATE TABLE prompt_records (
        id TEXT PRIMARY KEY NOT NULL,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        generated_result TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO prompt_records VALUES (
        'legacy-id', 'legacy-category', '旧分类', '[]', '{}', '旧版中英合并提示词',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    legacyConnection.close();

    const database = await PromptDatabase.open(vscode.Uri.file(storagePath));
    try {
      const [record] = database.listRecords('legacy-category');
      assert.strictEqual(record.id, 'legacy-id');
      assert.strictEqual(record.title, undefined);
      assert.strictEqual(record.projectId, '0');
      assert.strictEqual(record.generatedAt, undefined);
      assert.strictEqual(record.generatedResultChinese, '旧版中英合并提示词');
      assert.strictEqual(record.generatedResultEnglish, undefined);
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够迁移旧写作工作流标识并保留作品记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-writing-category-migration-'));
    const storageUri = vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage'));
    let database = await PromptDatabase.open(storageUri);

    try {
      const creativeRecord = database.saveRecord({
        title: '创意作品',
        categoryId: 'ai-video-creation-tools_collect_story_parameters',
        categoryName: '创意写故事',
        schema: [],
        data: { title: '创意作品' }
      });
      const imageRecord = database.saveRecord({
        title: '图片灵感作品',
        categoryId: 'ai-video-creation-tools_collect_image_story_parameters',
        categoryName: '图片写故事',
        schema: [],
        data: { title: '图片灵感作品' }
      });

      database.dispose();
      database = await PromptDatabase.open(storageUri);

      const migratedCreativeRecord = database.listRecords(CREATIVE_WRITING_WORKFLOW_NAME)[0];
      const migratedImageRecord = database.listRecords(IMAGE_INSPIRED_WRITING_WORKFLOW_NAME)[0];
      assert.strictEqual(migratedCreativeRecord.id, creativeRecord.id);
      assert.strictEqual(migratedCreativeRecord.categoryName, '创意写作');
      assert.strictEqual(migratedImageRecord.id, imageRecord.id);
      assert.strictEqual(migratedImageRecord.categoryName, '图片灵感写作');
      assert.deepStrictEqual(database.listRecords('ai-video-creation-tools_collect_story_parameters'), []);
      assert.deepStrictEqual(database.listRecords('ai-video-creation-tools_collect_image_story_parameters'), []);
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够将旧版项目结构迁移并保留原有关联', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-project-migration-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    fs.mkdirSync(storagePath);
    const databasePath = path.join(storagePath, 'prompt-records.sqlite');
    const legacyConnection = new DatabaseSync(databasePath);
    legacyConnection.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO episodes VALUES (
        'legacy-project-id', '旧作品项目', '已保存的项目简介',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      );
      CREATE TABLE prompt_records (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        generated_result_chinese TEXT,
        generated_result_english TEXT,
        generated_result_content TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      INSERT INTO prompt_records VALUES (
        'legacy-record-id', '旧故事章节', 'story', '故事创作', 'legacy-project-id',
        '[]', '{"title":"旧故事章节"}', NULL, NULL, '保留的正文',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      );
    `);
    legacyConnection.close();

    const database = await PromptDatabase.open(vscode.Uri.file(storagePath));
    try {
      assert.deepStrictEqual(database.listWorkProjects(), [{
        id: 'legacy-project-id',
        name: '旧作品项目',
        description: '已保存的项目简介',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }]);
      const record = database.getRecord('legacy-record-id');
      assert.strictEqual(record?.projectId, 'legacy-project-id');
      assert.strictEqual(record?.generatedResultContent, '保留的正文');
      assert.strictEqual(record?.generatedAt, undefined);
      assert.deepStrictEqual(database.listRecords('story', 'legacy-project-id'), [record]);
      const migratedDatabasePath = path.join(storagePath, 'creative-projects.sqlite');
      assert.ok(fs.existsSync(migratedDatabasePath));
      assert.ok(!fs.existsSync(databasePath));
      const migratedConnection = new DatabaseSync(migratedDatabasePath);
      try {
        const promptColumns = migratedConnection.prepare('PRAGMA table_info(prompt_records)').all() as { name: string }[];
        const projectColumns = migratedConnection.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
        assert.ok(promptColumns.some((column) => column.name === 'generated_at'));
        assert.ok(!promptColumns.some((column) => column.name === 'updated_at'));
        assert.ok(projectColumns.some((column) => column.name === 'updated_at'));
      } finally {
        migratedConnection.close();
      }
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('迁移合集数据库时保留项目关联并移除旧任务集数字段', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-collection-migration-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    fs.mkdirSync(storagePath);
    const legacyDatabasePath = path.join(storagePath, 'prompt-records.sqlite');
    const legacyConnection = new DatabaseSync(legacyDatabasePath);
    legacyConnection.exec(`
      CREATE TABLE collections (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO collections VALUES (
        'collection-id', '旧合集名称', '原项目简介',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      );
      CREATE TABLE prompt_records (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        episode_number INTEGER,
        schema_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        generated_result_chinese TEXT,
        generated_result_english TEXT,
        generated_result_content TEXT,
        created_at TEXT NOT NULL,
        generated_at TEXT
      );
      CREATE UNIQUE INDEX prompt_records_collection_task_episode_unique_idx
        ON prompt_records (collection_id, category_id, episode_number)
        WHERE collection_id <> '0' AND episode_number IS NOT NULL;
      INSERT INTO prompt_records VALUES (
        'collection-record-id', '旧任务', 'story', '创意写作', 'collection-id', 3,
        '[]', '{"title":"旧任务"}', NULL, NULL, NULL,
        '2026-01-03T00:00:00.000Z', NULL
      );
    `);
    legacyConnection.close();

    const database = await PromptDatabase.open(vscode.Uri.file(storagePath));
    try {
      assert.strictEqual(database.listWorkProjects()[0].id, 'collection-id');
      assert.strictEqual(database.listWorkProjects()[0].name, '旧合集名称');
      assert.strictEqual(database.getRecord('collection-record-id')?.projectId, 'collection-id');

      const migratedDatabasePath = path.join(storagePath, 'creative-projects.sqlite');
      assert.ok(fs.existsSync(migratedDatabasePath));
      assert.ok(!fs.existsSync(legacyDatabasePath));
      const migratedConnection = new DatabaseSync(migratedDatabasePath);
      try {
        const taskColumns = migratedConnection.prepare('PRAGMA table_info(prompt_records)').all() as { name: string }[];
        const projectTables = migratedConnection.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table'
        `).all() as { name: string }[];
        const uniqueIndexes = migratedConnection.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'prompt_records' AND sql LIKE '%episode_number%'
        `).all() as { name: string }[];
        assert.ok(taskColumns.some((column) => column.name === 'project_id'));
        assert.ok(!taskColumns.some((column) => column.name === 'collection_id' || column.name === 'episode_number'));
        assert.ok(projectTables.some((table) => table.name === 'projects'));
        assert.ok(!projectTables.some((table) => table.name === 'collections'));
        assert.deepStrictEqual(uniqueIndexes, []);
      } finally {
        migratedConnection.close();
      }
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够将记录页提交的参数一次性交给工作流工具', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-submission-'));
    let database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const workflow = formWorkflows[0];
    const values = { title: '已选记录', idea: '灯塔收到未来的信号' };
    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      submissions.set(workflow.toolName, values, 'saved-record-id');
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const response = result.content[0];
      assert.ok(response instanceof vscode.LanguageModelTextPart);
      assert.deepStrictEqual(JSON.parse(response.value).parameters, values);
      assert.strictEqual(JSON.parse(response.value).recordId, 'saved-record-id');
      assert.deepStrictEqual(database.listRecords(workflow.toolName), []);
      assert.strictEqual(submissions.take(workflow.toolName), undefined);
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('剧本运行时将关联任务的全部分集正文并入创作素材', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-screenplay-source-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const project = database.createWorkProject({ name: '测试项目', description: '' });
    const sourceRecord = database.saveRecord({
      title: '分集创意',
      categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
      categoryName: '创意写作',
      projectId: project.id,
      schema: [],
      data: { title: '分集创意' }
    });
    database.saveGeneratedChapterContents(sourceRecord.id, [
      { chapterNumber: 1, title: '第一集', content: '第一集完整正文' },
      { chapterNumber: 2, title: '第二集', content: '第二集完整正文' }
    ]);
    const workflow = formWorkflows.find((item) => item.toolName === SCREENPLAY_WORKFLOW_NAME);
    assert.ok(workflow);
    assert.ok(!workflow.fields.some((field) => field.name === 'sourceMaterial'));
    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      submissions.set(workflow.toolName, {
        title: '改编剧本',
        sourceTaskId: sourceRecord.id,
        sourceMaterial: '不应使用的旧手填素材',
        maxEpisodeDurationSeconds: '60',
        maxEpisodes: '2',
        genre: '悬疑',
        style: '写实自然',
        additionalInfo: ''
      }, undefined, project.id);
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const textPart = result.content[0];
      assert.ok(textPart instanceof vscode.LanguageModelTextPart);
      const parameters = JSON.parse(textPart.value).parameters;
      assert.ok(parameters.sourceMaterial.includes('第一集完整正文'));
      assert.ok(parameters.sourceMaterial.includes('第二集完整正文'));
      assert.ok(!parameters.sourceMaterial.includes('不应使用的旧手填素材'));
      assert.strictEqual(parameters.sourceTaskId, undefined);
      assert.strictEqual(parameters.maxEpisodeDurationSeconds, 60);
      assert.strictEqual(parameters.maxEpisodes, 2);
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够将图片灵感写作附件作为图像内容交给 Copilot', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-image-submission-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const workflow = formWorkflows.find((item) => item.supportsImageAttachments);
    assert.ok(workflow);
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const values = {
      title: '图片参考',
      [IMAGE_ATTACHMENTS_FIELD]: JSON.stringify([{
        mimeType: 'image/png',
        data: imageBytes.toString('base64')
      }])
    };
    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      submissions.set(workflow.toolName, values);
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const textPart = result.content[0];
      const imagePart = result.content[1];
      assert.ok(textPart instanceof vscode.LanguageModelTextPart);
      assert.deepStrictEqual(JSON.parse(textPart.value).parameters, { title: '图片参考' });
      assert.ok(imagePart instanceof vscode.LanguageModelDataPart);
      assert.strictEqual(imagePart.mimeType, 'image/png');
      assert.deepStrictEqual(Buffer.from(imagePart.data), imageBytes);
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够将 Copilot 返回的双语提示词保存到指定记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-result-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const record = database.saveRecord({
      title: '待生成记录',
      categoryId: 'ai-video-creation-tools_collect_character_parameters',
      categoryName: '创意写作',
      schema: [],
      data: { title: '待生成记录' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      database.updateGeneratedContent(record.id, '上次生成的单篇正文');
      database.saveGeneratedChapterContents(record.id, [
        { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
      ]);
      await tool.invoke({
        input: {
          recordId: record.id,
          contentZh: 'Copilot 返回的中文提示词',
          contentEn: 'Copilot returned the English prompt'
        },
        toolInvocationToken: undefined
      }, cancellationSource.token);
      assert.strictEqual(database.getRecord(record.id)?.generatedResultChinese, 'Copilot 返回的中文提示词');
      assert.strictEqual(database.getRecord(record.id)?.generatedResultEnglish, 'Copilot returned the English prompt');
      assert.strictEqual(database.getRecord(record.id)?.generatedResultContent, undefined);
      assert.deepStrictEqual(database.listGeneratedChapterContents(record.id), []);
      await assert.rejects(
        tool.invoke({
          input: {
            recordId: 'missing-record',
            contentZh: '不应写入的内容',
            contentEn: 'Content that must not be saved'
          },
          toolInvocationToken: undefined
        }, cancellationSource.token),
        /提示词记录不存在/
      );
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('图片灵感写作按任务保存章节内容并遵守章节数与字数范围', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-story-result-'));
    let database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const record = database.saveRecord({
      title: '待生成作品',
      categoryId: IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
      categoryName: '图片灵感写作',
      schema: [],
      data: { title: '待生成作品', chapterMinWords: '500', chapterMaxWords: '2500', maxChapters: '2' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      database.updateGeneratedContent(record.id, '上次生成的单篇正文');
      database.updateGeneratedResult(record.id, '上次中文提示词', 'Previous English prompt');
      database.saveGeneratedChapterContents(record.id, [
        { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
      ]);
      await assert.rejects(
        tool.invoke({
          input: {
            recordId: record.id,
            chapters: [
              { chapterNumber: 1, title: '第一章', content: '第一章正文' },
              { chapterNumber: 2, title: '第二章', content: '第二章正文' },
              { chapterNumber: 3, title: '第三章', content: '第三章正文' }
            ]
          },
          toolInvocationToken: undefined
        }, cancellationSource.token),
        /不能超过表单设定的 2 章/
      );
      assert.strictEqual(database.getRecord(record.id)?.generatedResultContent, '上次生成的单篇正文');
      assert.strictEqual(database.getRecord(record.id)?.generatedResultChinese, '上次中文提示词');
      assert.strictEqual(database.getRecord(record.id)?.generatedResultEnglish, 'Previous English prompt');
      assert.deepStrictEqual(database.listGeneratedChapterContents(record.id), [
        { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
      ]);
      const generatedChapters = [
        { chapterNumber: 1, title: '灯塔来信', content: '雨'.repeat(500) },
        { chapterNumber: 2, title: '潮汐之后', content: '潮'.repeat(500) }
      ];
      await assert.rejects(
        tool.invoke({
          input: {
            recordId: record.id,
            chapters: [{ chapterNumber: 1, title: '过短章节', content: '字'.repeat(499) }]
          },
          toolInvocationToken: undefined
        }, cancellationSource.token),
        /第 1 章正文统计为 499 字，必须在 500 到 2500 字之间/
      );
      await tool.invoke({
        input: { recordId: record.id, chapters: generatedChapters },
        toolInvocationToken: undefined
      }, cancellationSource.token);
      const savedRecord = database.getRecord(record.id);
      assert.strictEqual(savedRecord?.generatedResultContent, undefined);
      assert.strictEqual(savedRecord?.generatedResultChinese, undefined);
      assert.strictEqual(savedRecord?.generatedResultEnglish, undefined);
      assert.ok(savedRecord?.generatedAt);
      assert.deepStrictEqual(database.listGeneratedChapterContents(record.id), generatedChapters);
      await assert.rejects(
        tool.invoke({
          input: {
            recordId: record.id,
            chapters: generatedChapters,
            contentZh: '不得保存为提示词',
            contentEn: 'Must not save as prompts'
          },
          toolInvocationToken: undefined
        }, cancellationSource.token),
        /必须提交按章拆分的内容/
      );
      database.dispose();
      database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
      assert.deepStrictEqual(database.listGeneratedChapterContents(record.id), generatedChapters);
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('非拍摄脚本内容工作流只保存单篇创作内容', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-content-results-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();
    const contentWorkflows = formWorkflows.filter((workflow) =>
      workflow.resultType === 'content' &&
      workflow.supportsChapterContent !== true &&
      workflow.toolName !== SHOOTING_SCRIPT_WORKFLOW_NAME
    );

    try {
      assert.deepStrictEqual(contentWorkflows.map((workflow) => workflow.title), [
        '剧本创作'
      ]);
      for (const workflow of contentWorkflows) {
        const record = database.saveRecord({
          title: workflow.title,
          categoryId: workflow.toolName,
          categoryName: workflow.title,
          schema: [],
          data: { title: workflow.title }
        });
        database.updateGeneratedResult(record.id, '上次中文提示词', 'Previous English prompt');
        database.saveGeneratedChapterContents(record.id, [
          { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
        ]);
        const generatedContent = `${workflow.title}的完整作品内容`;
        await tool.invoke({
          input: { recordId: record.id, content: generatedContent },
          toolInvocationToken: undefined
        }, cancellationSource.token);

        const savedRecord = database.getRecord(record.id);
        assert.strictEqual(savedRecord?.generatedResultContent, generatedContent);
        assert.strictEqual(savedRecord?.generatedResultChinese, undefined);
        assert.strictEqual(savedRecord?.generatedResultEnglish, undefined);
        assert.deepStrictEqual(database.listGeneratedChapterContents(record.id), []);
      }
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('拍摄脚本分别保存中文和英文作品内容', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-shooting-result-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const record = database.saveRecord({
      title: '双语拍摄脚本',
      categoryId: SHOOTING_SCRIPT_WORKFLOW_NAME,
      categoryName: '拍摄脚本制作',
      schema: [],
      data: { title: '双语拍摄脚本' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      await tool.invoke({
        input: {
          recordId: record.id,
          contentZh: '中文拍摄脚本正文',
          contentEn: 'English shooting script body'
        },
        toolInvocationToken: undefined
      }, cancellationSource.token);

      const savedRecord = database.getRecord(record.id);
      assert.strictEqual(savedRecord?.generatedResultChinese, '中文拍摄脚本正文');
      assert.strictEqual(savedRecord?.generatedResultEnglish, 'English shooting script body');
      assert.strictEqual(savedRecord?.generatedResultContent, undefined);
      await assert.rejects(
        tool.invoke({
          input: { recordId: record.id, content: '不能作为单篇内容保存' },
          toolInvocationToken: undefined
        }, cancellationSource.token),
        /必须提交中英文内容/
      );
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够激活扩展并注册参数表单工具和结果保存工具', async () => {
    const extension = vscode.extensions.getExtension('chengbin.ai-video-creation-assistant');

    if (!extension) {
      throw new Error('未找到 AI视频创作助手扩展。');
    }

    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    const registeredTools = vscode.lm.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('ai-video-creation-tools_collect_'))
      .sort();

    assert.deepStrictEqual(registeredTools, [
      'ai-video-creation-tools_collect_character_parameters',
      'ai-video-creation-tools_collect_creative_writing_parameters',
      'ai-video-creation-tools_collect_effect_parameters',
      'ai-video-creation-tools_collect_image_inspired_writing_parameters',
      'ai-video-creation-tools_collect_novel_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_screenplay_parameters',
      'ai-video-creation-tools_collect_shooting_script_parameters'
    ]);
    assert.ok(vscode.lm.tools.some((tool) => tool.name === SAVE_GENERATED_RESULT_TOOL_NAME));

    const contributions = extension.packageJSON.contributes;
    assert.strictEqual(
      contributions.configurationDefaults['github.copilot.chat.imageUpload.enabled'],
      false
    );
    const expectedWorkflowOrder = [
      'ai-video-creation-tools_collect_creative_writing_parameters',
      'ai-video-creation-tools_collect_image_inspired_writing_parameters',
      'ai-video-creation-tools_collect_novel_parameters',
      'ai-video-creation-tools_collect_character_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_effect_parameters',
      'ai-video-creation-tools_collect_screenplay_parameters',
      'ai-video-creation-tools_collect_shooting_script_parameters'
    ];
    assert.deepStrictEqual(formWorkflows.map((workflow) => workflow.toolName), expectedWorkflowOrder);
    assert.deepStrictEqual(
      formWorkflows.filter((workflow) => workflow.resultType === 'content').map((workflow) => workflow.title),
      ['创意写作', '图片灵感写作', '小说重创作', '剧本创作', '拍摄脚本制作']
    );
    assert.deepStrictEqual(
      contributions.languageModelTools
        .map((tool: { name: string }) => tool.name)
        .filter((name: string) => name.startsWith('ai-video-creation-tools_collect_')),
      expectedWorkflowOrder
    );
    assert.deepStrictEqual(
      extension.packageJSON.activationEvents
        .filter((event: string) => event.startsWith('onLanguageModelTool:ai-video-creation-tools_collect_'))
        .map((event: string) => event.replace('onLanguageModelTool:', '')),
      expectedWorkflowOrder
    );
    assert.deepStrictEqual(
      contributions.chatPromptFiles.map((prompt: { path: string }) => path.basename(prompt.path)),
      [
        'creative-writing.prompt.md',
        'image-inspired-writing.prompt.md',
        'novel-adaptation.prompt.md',
        'character-generation.prompt.md',
        'scene-generation.prompt.md',
        'prop-generation.prompt.md',
        'effect-generation.prompt.md',
        'screenplay.prompt.md',
        'shooting-script.prompt.md'
      ]
    );
    const activityBarContainer = contributions.viewsContainers.activitybar.find(
      (container: { id: string }) => container.id === 'aiVideoCreation'
    );
    assert.ok(activityBarContainer);
    assert.strictEqual(activityBarContainer.icon, './resources/ai-video-creation.svg');
    assert.ok(fs.existsSync(path.join(extension.extensionUri.fsPath, activityBarContainer.icon)));
    const activityBarIcon = fs.readFileSync(
      path.join(extension.extensionUri.fsPath, activityBarContainer.icon),
      'utf8'
    );
    assert.ok(activityBarIcon.includes('<path'));
    assert.ok(activityBarIcon.includes('M18 14H55Q63 14 63 22'));
    assert.strictEqual((activityBarIcon.match(/<circle /g) ?? []).length, 2);
    assert.ok(!activityBarIcon.includes('<image'));
    assert.deepStrictEqual(
      contributions.views.aiVideoCreation.map((view: { id: string; type: string }) => ({
        id: view.id,
        type: view.type
      })),
      [{ id: 'aiVideoCreation.promptRecords', type: 'webview' }]
    );
    assert.strictEqual(contributions.chatAgents.length, 1);
    assert.strictEqual(contributions.chatSkills.length, 1);
    assert.strictEqual(contributions.chatPromptFiles.length, 9);
    const extensionRoot = extension.extensionUri.fsPath;
    const contributedPaths = [
      ...contributions.chatAgents,
      ...contributions.chatSkills,
      ...contributions.chatPromptFiles
    ];

    for (const contribution of contributedPaths) {
      assert.ok(fs.existsSync(path.join(extensionRoot, contribution.path)));
      assert.strictEqual('name' in contribution, false);
      assert.strictEqual('description' in contribution, false);
    }

    const imagePromptWorkflows = [
      'ai-video-creation-tools_collect_character_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_effect_parameters'
    ];

    for (const toolName of imagePromptWorkflows) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      assert.ok(!workflow.fields.some((field) => field.name === 'task'));
    }

    const expectedFieldNames: Readonly<Record<string, readonly string[]>> = {
      'ai-video-creation-tools_collect_creative_writing_parameters': [
        'title', 'idea', 'genre', 'chapterMinWords', 'chapterMaxWords', 'maxChapters', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_image_inspired_writing_parameters': [
        'title', 'genre', 'chapterMinWords', 'chapterMaxWords', 'maxChapters', 'visualElements', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_novel_parameters': [
        'title', 'target', 'chapterMinWords', 'chapterMaxWords', 'maxChapters', 'preserve', 'adjustments', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_character_parameters': [
        'title', 'characterType', 'appearance', 'clothing', 'expressionPose', 'composition', 'style', 'background', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_scene_parameters': [
        'title', 'placeType', 'layout', 'environment', 'composition', 'style', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_prop_parameters': [
        'title', 'propName', 'appearance', 'state', 'composition', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_effect_parameters': [
        'title', 'source', 'appearance', 'motion', 'environmentInteraction', 'composition', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_screenplay_parameters': [
        'title', 'sourceTaskId', 'maxEpisodeDurationSeconds', 'maxEpisodes', 'genre', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_shooting_script_parameters': [
        'title', 'scriptSource', 'duration', 'aspectRatio', 'visualStyle', 'cameraStyle', 'additionalInfo'
      ]
    };

    for (const [toolName, fieldNames] of Object.entries(expectedFieldNames)) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      assert.deepStrictEqual(workflow.fields.map((field) => field.name), fieldNames);
      assert.strictEqual(workflow.fields[0].required, true);
      assert.ok(workflow.fields.some((field) => field.name === 'additionalInfo'));
    }

    const chapterContentWorkflows = formWorkflows.filter((workflow) => workflow.supportsChapterContent);
    assert.strictEqual(chapterContentWorkflows.length, 3);
    for (const workflow of chapterContentWorkflows) {
      const chapterMinWords = workflow.fields.find((field) => field.name === 'chapterMinWords');
      const chapterMaxWords = workflow.fields.find((field) => field.name === 'chapterMaxWords');
      const maxChapters = workflow.fields.find((field) => field.name === 'maxChapters');
      assert.strictEqual(chapterMinWords?.inputType, 'number');
      assert.strictEqual(chapterMinWords?.min, 200);
      assert.strictEqual(chapterMinWords?.required, true);
      assert.strictEqual(chapterMaxWords?.inputType, 'number');
      assert.strictEqual(chapterMaxWords?.max, 20000);
      assert.strictEqual(chapterMaxWords?.required, true);
      assert.strictEqual(maxChapters?.inputType, 'number');
      assert.strictEqual(maxChapters?.min, 1);
      assert.strictEqual(maxChapters?.max, 100);
      assert.strictEqual(maxChapters?.required, true);
    }

    const characterWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_character_parameters');
    assert.ok(characterWorkflow);
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'characterType')?.options,
      ['人类', '动物', '怪物', '丧尸', '其他']
    );
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'composition')?.options,
      ['正面全身像', '三视图（正面、侧面、背面）', '正面半身像', '侧面全身像', '面部特写']
    );
    assert.strictEqual(characterWorkflow.fields.find((field) => field.name === 'composition')?.allowCustom, true);
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'style')?.options,
      ['写实电影风格', '写实摄影', '2D动漫插画', '3D动画风格', '游戏概念设计', '水彩插画', '黑白线稿']
    );
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'background')?.options,
      ['纯白背景', '浅灰纯色背景', '纯色背景', '简洁渐变背景', '与角色设定相符的环境背景']
    );

    const shootingScriptWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_shooting_script_parameters');
    assert.ok(shootingScriptWorkflow);
    assert.deepStrictEqual(
      shootingScriptWorkflow.fields.find((field) => field.name === 'visualStyle')?.options,
      ['写实电影风格', '写实摄影', '2D动漫插画', '3D动画风格', '游戏概念设计', '水彩插画', '黑白线稿']
    );
    assert.deepStrictEqual(
      shootingScriptWorkflow.fields.find((field) => field.name === 'cameraStyle')?.options,
      ['固定机位（稳定中近景）', '缓慢推近', '缓慢拉远', '横向摇摄', '跟随移动镜头', '手持纪实感', '低机位仰拍', '俯拍全景', '浅景深特写']
    );
    assert.strictEqual(shootingScriptWorkflow.fields.find((field) => field.name === 'cameraStyle')?.allowCustom, true);

    const customizableFields = formWorkflows.flatMap((workflow) => workflow.fields)
      .filter((field) => field.allowCustom);
    assert.ok(customizableFields.length > 0);
    assert.ok(customizableFields.every((field) => Boolean(field.options)));

    assert.ok(formWorkflows.every((workflow) => workflow.fields
      .filter((field) => !field.options)
      .every((field) => Boolean(field.placeholder))));

    const agentPath = path.join(extensionRoot, contributions.chatAgents[0].path);
    const agentContent = fs.readFileSync(agentPath, 'utf8');
    const agentFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agentContent);
    assert.ok(agentFrontmatter);
    const agentMetadata = parseYaml(agentFrontmatter[1]);
    assert.strictEqual(agentMetadata.name, 'AI 视频创作');
    assert.ok(agentMetadata.description);
    assert.ok(agentContent.includes('如果当前会话未加载该 Skill 或无法使用其规则，立即停止；不得调用参数表单工具或继续生成'));
    assert.ok(agentContent.includes('工具返回 `status: cancelled` 时停止本次任务'));
    assert.ok(agentContent.includes('返回 `status: submitted` 时从 `parameters` 读取已提交内容继续'));
    assert.ok(agentContent.includes('直接分析图片参数工具结果中的图片，不要求用户将同一图片另行附加到 Copilot 聊天'));
    assert.ok(agentContent.includes('创意写作、图片灵感写作、小说重创作、剧本创作和拍摄脚本制作'));
    assert.ok(agentContent.includes('创意写作、图片灵感写作和小说重创作使用 `chapters` 数组'));

    const skillPath = path.join(extensionRoot, contributions.chatSkills[0].path);
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const skillFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillContent);
    assert.ok(skillFrontmatter);
    const skillMetadata = parseYaml(skillFrontmatter[1]);
    assert.strictEqual(skillMetadata.name, 'ai-video-prompt-design');
    assert.strictEqual(path.basename(path.dirname(skillPath)), skillMetadata.name);
    assert.ok(skillMetadata.description);
    assert.ok(skillContent.includes('编写下游提示词时，用户明确提出且彼此不冲突的要求必须完整纳入'));
    assert.ok(skillContent.includes('拍摄脚本直接创作'));
    assert.ok(skillContent.includes('分别编写完整、语义一致的中文提示词和英文提示词'));
    assert.ok(!skillContent.includes('中文与英文提示词'));
    assert.ok(!skillContent.includes('代码围栏'));
    assert.ok(!skillContent.includes('必须使用同一个标注为'));

    const promptTools = [
      ['creative-writing.prompt.md', 'ai-video-creation-tools_collect_creative_writing_parameters', '## 任务'],
      ['image-inspired-writing.prompt.md', 'ai-video-creation-tools_collect_image_inspired_writing_parameters', '## 图片关系'],
      ['novel-adaptation.prompt.md', 'ai-video-creation-tools_collect_novel_parameters', '## 原作要求'],
      ['character-generation.prompt.md', 'ai-video-creation-tools_collect_character_parameters', '## 角色设定流程'],
      ['scene-generation.prompt.md', 'ai-video-creation-tools_collect_scene_parameters', '## 场景设定流程'],
      ['prop-generation.prompt.md', 'ai-video-creation-tools_collect_prop_parameters', '## 道具设定流程'],
      ['effect-generation.prompt.md', 'ai-video-creation-tools_collect_effect_parameters', '## 特效设定流程'],
      ['screenplay.prompt.md', 'ai-video-creation-tools_collect_screenplay_parameters', '## 素材与范围'],
      ['shooting-script.prompt.md', 'ai-video-creation-tools_collect_shooting_script_parameters', '## 素材与交付范围']
    ];

    for (const [promptName, toolName, domainInstructionsHeading] of promptTools) {
      const promptPath = path.join(extensionRoot, 'copilot-customizations', 'prompts', promptName);
      const promptContent = fs.readFileSync(promptPath, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(promptContent);
      assert.ok(frontmatter);
      const metadata = parseYaml(frontmatter[1]);
      assert.ok(metadata.name);
      assert.ok(metadata.description);
      assert.strictEqual(metadata.agent, 'AI 视频创作');
      assert.strictEqual(metadata.tools, undefined);
      assert.ok(promptContent.includes(toolName));
      assert.ok(promptContent.includes(domainInstructionsHeading));
      assert.ok(!promptContent.includes('ai-video-prompt-design'));
      assert.ok(!promptContent.includes('分别输出完整的中文提示词正文'));
      assert.ok(!promptContent.includes('分别编写完整的中文提示词'));
      assert.ok(!promptContent.includes('不添加标签、代码围栏'));
      assert.ok(promptContent.includes('## 参数工具'));
      assert.ok(!promptContent.includes('status: cancelled'));
      assert.ok(!promptContent.includes('status: submitted'));
      assert.ok(!promptContent.includes('不要把参数列表输出为聊天文本'));
      assert.ok(!promptContent.includes('空字段'));
      if (promptName === 'character-generation.prompt.md') {
        assert.ok(promptContent.includes('角色类型和主体'));
        assert.ok(promptContent.includes('丧尸的腐坏特征'));
      }
      if (promptName === 'image-inspired-writing.prompt.md') {
        assert.ok(promptContent.includes('分别分析，不擅自建立人物或事件联系'));
      }
      if (promptName === 'creative-writing.prompt.md') {
        assert.ok(promptContent.includes('素材不足时宁可少写，不得重复情节、注水或补造设定来凑字数或章节'));
      }
      if (promptName === 'novel-adaptation.prompt.md') {
        assert.ok(promptContent.includes('原作文本、章节、梗概或可读取的文件内容是改编必需材料'));
      }
      if (promptName === 'screenplay.prompt.md') {
        assert.ok(promptContent.includes('不擅自改成分镜、拍摄计划或整套制作材料'));
      }
      if (promptName === 'shooting-script.prompt.md') {
        assert.ok(promptContent.includes('每个镜头均包含可单独用于视频生成的动态画面提示词'));
        assert.ok(promptContent.includes('完整的中文拍摄脚本和英文拍摄脚本'));
        assert.ok(promptContent.includes('中文正文提交到 `contentZh`，英文正文提交到 `contentEn`'));
      }
    }

    const saveResultContribution = contributions.languageModelTools.find(
      (tool: { name: string }) => tool.name === SAVE_GENERATED_RESULT_TOOL_NAME
    );
    assert.ok(saveResultContribution);
    assert.deepStrictEqual(saveResultContribution.inputSchema.required, ['recordId']);
    assert.strictEqual(saveResultContribution.inputSchema.oneOf.length, 3);
    const recordsViewSource = fs.readFileSync(path.join(extensionRoot, 'src', 'promptRecordsView.ts'), 'utf8');
    assert.ok(recordsViewSource.includes("function getResultActionLabel(workflowId)"));
    assert.ok(recordsViewSource.includes("if (screenplayWorkflowIds.includes(workflowId)) return '查看剧本';"));
    assert.ok(recordsViewSource.includes("if (bilingualContentWorkflowIds.includes(workflowId)) return '查看拍摄脚本';"));
    assert.ok(recordsViewSource.includes("if (chapterContentWorkflowIds.includes(workflowId) || contentWorkflowIds.includes(workflowId)) return '查看内容';"));
    assert.ok(recordsViewSource.includes('id="run-confirm-dialog"'));
    assert.ok(recordsViewSource.includes('inputmode="numeric" pattern="[0-9]{4}" maxlength="4"'));
    assert.ok(recordsViewSource.includes('const requiresCode = Boolean(record.generatedAt);'));
    assert.ok(recordsViewSource.includes("String(values[0] % 10000).padStart(4, '0')"));
    assert.ok(recordsViewSource.includes("command: 'run-record', recordId"));
    assert.ok(recordsViewSource.includes("className = 'record-cell row-action-column'"));
    assert.ok(recordsViewSource.includes('#records-table .record-actions { margin-left: -8px; }'));
    assert.ok(recordsViewSource.includes("command: 'view-chapters'"));
    assert.ok(recordsViewSource.includes('<span role="columnheader">章节</span><span role="columnheader">章节内容</span>'));
    assert.ok(recordsViewSource.includes('<span class="chapter-content-action-column">操作</span>'));
    assert.ok(recordsViewSource.includes('<span class="row-action-column">操作</span>'));
    assert.ok(recordsViewSource.includes('<span>创建时间</span><span>操作</span>'));
    assert.ok(recordsViewSource.includes('id="generated-content" aria-label="Copilot 生成的内容："'));
    assert.ok(recordsViewSource.includes("'bilingual-content'"));
    assert.ok(recordsViewSource.includes("isScreenplay ? 'Copilot 生成的剧本内容' : 'Copilot 生成的内容'"));
    assert.ok(recordsViewSource.includes("? 'Copilot 生成的中文拍摄脚本'"));
    assert.ok(recordsViewSource.includes(": 'Copilot 生成的中文提示词'"));
    assert.ok(recordsViewSource.includes("? 'Copilot 生成的英文拍摄脚本'"));
    assert.ok(recordsViewSource.includes(": 'Copilot 生成的英文提示词'"));
    assert.ok(recordsViewSource.includes('id="prompt-result-fields" hidden'));
  });
});
