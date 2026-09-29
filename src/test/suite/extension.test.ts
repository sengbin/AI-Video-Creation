import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { PromptDatabase, UNIQUE_CONTENT_TASK_WORKFLOW_NAMES } from '../../database';
import { PromptRecordsViewProvider } from '../../promptRecordsView';
import {
  formatOriginalSourceFileSize,
  parseImageAttachments,
  parseOriginalSourceFile,
  renderAddRecordFields,
  validateWorkflowFormValues
} from '../../formPanel';
import {
  formWorkflows,
  CREATIVE_WRITING_WORKFLOW_NAME,
  IMAGE_ATTACHMENTS_FIELD,
  IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
  NOVEL_RECREATION_WORKFLOW_NAME,
  ORIGINAL_SOURCE_FILE_FIELD,
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
    assert.ok(!workflow.fields.some((field) => field.name === 'taskName'));
    assert.ok(!workflow.notice.includes('任务名称'));
    assert.ok(!workflow.fields.some((field) => field.name === 'format'));
    assert.ok(workflow.fields.some((field) => field.name === 'maxEpisodeDurationSeconds' && field.required));
    assert.ok(!workflow.fields.some((field) => field.name === 'episodeDurationSeconds'));
    assert.ok(workflow.fields.some((field) => field.name === 'maxEpisodes' && field.required));
    assert.ok(!workflow.fields.some((field) => field.name === 'genre' || field.name === 'style'));
    const creativeWorkflow = formWorkflows.find((item) => item.toolName === CREATIVE_WRITING_WORKFLOW_NAME);
    const imageWorkflow = formWorkflows.find((item) => item.toolName === IMAGE_INSPIRED_WRITING_WORKFLOW_NAME);
    assert.ok(creativeWorkflow?.fields.some((field) => field.name === 'genre'));
    assert.ok(!creativeWorkflow?.fields.some((field) => field.name === 'style'));
    assert.deepStrictEqual(creativeWorkflow?.fields.find((field) => field.name === 'genre')?.options, [
      '悬疑', '爱情', '科幻', '奇幻', '喜剧', '现实题材', '历史', '武侠', '冒险', '恐怖'
    ]);
    assert.strictEqual(creativeWorkflow?.fields.find((field) => field.name === 'genre')?.allowCustom, true);
    assert.strictEqual(creativeWorkflow?.fields.find((field) => field.name === 'genre')?.customInputBelow, true);
    assert.ok(imageWorkflow?.fields.some((field) => field.name === 'genre'));
    assert.strictEqual(imageWorkflow?.fields.find((field) => field.name === 'genre')?.label, '题材');
    assert.deepStrictEqual(imageWorkflow?.fields.find((field) => field.name === 'genre')?.options, [
      '悬疑', '爱情', '科幻', '奇幻', '喜剧', '现实题材', '历史', '武侠', '冒险', '恐怖'
    ]);
    assert.strictEqual(imageWorkflow?.fields.find((field) => field.name === 'genre')?.allowCustom, true);
    assert.ok(!imageWorkflow?.fields.some((field) => field.name === 'style'));
    const creativeHtml = renderAddRecordFields(creativeWorkflow, []);
    assert.ok(creativeHtml.includes('<select id="genre" name="genre" data-custom-input="genre-custom">'));
    assert.ok(creativeHtml.includes('<div class="select-with-custom custom-input-below">'));
    assert.ok(creativeHtml.includes('<option value="__custom__">其他</option>'));

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-screenplay-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    try {
      const project = database.createWorkProject({ name: '剧本项目', description: '' });
      const task = database.saveRecord({
        taskName: '故事创意',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        projectId: project.id,
        schema: [{ name: 'taskName' }],
        data: { taskName: '故事创意' }
      });
      database.updateGeneratedContent(task.id, '完整生成正文');
      database.saveRecord({
        taskName: '尚未生成的任务',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        projectId: project.id,
        schema: [{ name: 'taskName' }],
        data: { taskName: '尚未生成的任务' }
      });

      const tasks = database.listGeneratedContentTasks([CREATIVE_WRITING_WORKFLOW_NAME], []);
      assert.deepStrictEqual(tasks.map((item) => item.id), [task.id]);
      const html = renderAddRecordFields(workflow, [project], {}, tasks);
      assert.ok(!html.includes('name="taskName"'));
      assert.ok(!html.includes('未归属项目'));
      assert.ok(html.includes('name="projectId" required'));
      assert.ok(html.includes(`value="${task.id}" data-project-id="${project.id}"`));

      const screenplay = database.saveRecord({
        taskName: '不应保存的名称快照',
        categoryId: SCREENPLAY_WORKFLOW_NAME,
        categoryName: '剧本创作',
        projectId: project.id,
        schema: [{ name: 'sourceTaskId' }],
        data: { sourceTaskId: task.id }
      });
      database.updateGeneratedContent(screenplay.id, '生成的剧本正文');
      const storedDatabase = new DatabaseSync(path.join(temporaryDirectory, 'globalStorage', 'creative-projects.sqlite'));
      try {
        const storedTaskName = storedDatabase.prepare(
          'SELECT task_name FROM prompt_records WHERE id = ?'
        ).get(screenplay.id) as { task_name: string };
        assert.strictEqual(storedTaskName.task_name, '');
      } finally {
        storedDatabase.close();
      }

      database.updateRecord(task.id, {
        taskName: '改名后的故事创意',
        projectId: project.id,
        schema: [{ name: 'taskName' }],
        data: { taskName: '改名后的故事创意' }
      });
      assert.strictEqual(database.getRecord(screenplay.id)?.taskName, '改名后的故事创意');
      assert.strictEqual(
        database.listGeneratedContentTasks([SCREENPLAY_WORKFLOW_NAME], []).find((item) => item.id === screenplay.id)?.taskName,
        '改名后的故事创意'
      );
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('剧本关联字段文案更新且三类内容创作任务名称全局唯一', async () => {
    const screenplayWorkflow = formWorkflows.find((item) => item.toolName === SCREENPLAY_WORKFLOW_NAME);
    assert.strictEqual(
      screenplayWorkflow?.fields.find((field) => field.name === 'sourceTaskId')?.label,
      '关联内容创作任务'
    );

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-unique-task-name-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    try {
      const project = database.createWorkProject({ name: '项目一', description: '' });
      const otherProject = database.createWorkProject({ name: '项目二', description: '' });
      const existingTask = database.saveRecord({
        taskName: '同名任务',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        projectId: project.id,
        schema: [],
        data: {}
      });

      assert.throws(
        () => database.assertTaskNameUnique('同名任务', UNIQUE_CONTENT_TASK_WORKFLOW_NAMES),
        /任务名称已存在/
      );
      assert.throws(
        () => database.assertTaskNameUnique(' 同名任务 ', UNIQUE_CONTENT_TASK_WORKFLOW_NAMES),
        /任务名称已存在/
      );
      assert.doesNotThrow(() => database.assertTaskNameUnique('同名任务', UNIQUE_CONTENT_TASK_WORKFLOW_NAMES, existingTask.id));
      assert.doesNotThrow(() => database.assertTaskNameUnique('其他任务', UNIQUE_CONTENT_TASK_WORKFLOW_NAMES));

      assert.throws(() => database.saveRecord({
        taskName: ' 同名任务 ',
        categoryId: IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
        categoryName: '图片灵感写作',
        projectId: otherProject.id,
        schema: [],
        data: {}
      }), /任务名称已存在/);

      const imageTask = database.saveRecord({
        taskName: '图片任务',
        categoryId: IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
        categoryName: '图片灵感写作',
        projectId: otherProject.id,
        schema: [],
        data: {}
      });
      assert.throws(() => database.updateRecord(imageTask.id, {
        taskName: '同名任务',
        projectId: otherProject.id,
        schema: [],
        data: {}
      }), /任务名称已存在/);

      assert.doesNotThrow(() => database.saveRecord({
        taskName: '同名任务',
        categoryId: 'other-workflow',
        categoryName: '其他工作流',
        projectId: otherProject.id,
        schema: [],
        data: {}
      }));
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('拍摄脚本关联当前项目已生成的剧本并传入剧本正文', async () => {
    const workflow = formWorkflows.find((item) => item.toolName === SHOOTING_SCRIPT_WORKFLOW_NAME);
    assert.ok(workflow);
    assert.strictEqual(workflow.requiresProject, true);
    assert.ok(!workflow.fields.some((field) => field.name === 'taskName'));
    assert.ok(!workflow.notice.includes('任务名称'));
    const screenplayField = workflow.fields.find((field) => field.name === 'screenplayTaskId');
    assert.strictEqual(screenplayField?.label, '关联剧本任务');
    assert.strictEqual(screenplayField?.placeholder, '请选择剧本创作任务');
    assert.strictEqual(screenplayField?.projectTaskCategory, SCREENPLAY_WORKFLOW_NAME);
    assert.strictEqual(screenplayField?.required, true);

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-shooting-source-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const project = database.createWorkProject({ name: '当前项目', description: '' });
    const otherProject = database.createWorkProject({ name: '其他项目', description: '' });
    const sourceContentTask = database.saveRecord({
      taskName: '关联的内容任务',
      categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
      categoryName: '创意写作',
      projectId: project.id,
      schema: [],
      data: { taskName: '关联的内容任务' }
    });
    database.updateGeneratedContent(sourceContentTask.id, '创作内容正文');
    const screenplay = database.saveRecord({
      taskName: '',
      categoryId: SCREENPLAY_WORKFLOW_NAME,
      categoryName: '剧本创作',
      projectId: project.id,
      schema: [],
      data: { sourceTaskId: sourceContentTask.id }
    });
    database.updateGeneratedContent(screenplay.id, '剧本完整正文');
    const otherProjectScreenplay = database.saveRecord({
      taskName: '其他项目剧本',
      categoryId: SCREENPLAY_WORKFLOW_NAME,
      categoryName: '剧本创作',
      projectId: otherProject.id,
      schema: [],
      data: { taskName: '其他项目剧本' }
    });
    database.updateGeneratedContent(otherProjectScreenplay.id, '其他项目正文');
    database.saveRecord({
      taskName: '尚未生成的剧本',
      categoryId: SCREENPLAY_WORKFLOW_NAME,
      categoryName: '剧本创作',
      projectId: project.id,
      schema: [],
      data: { taskName: '尚未生成的剧本' }
    });
    const unrelatedTask = database.saveRecord({
      taskName: '已生成的创意',
      categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
      categoryName: '创意写作',
      projectId: project.id,
      schema: [],
      data: { taskName: '已生成的创意' }
    });
    database.updateGeneratedContent(unrelatedTask.id, '创意正文');
    const generatedTasks = database.listGeneratedContentTasks(
      [SCREENPLAY_WORKFLOW_NAME, CREATIVE_WRITING_WORKFLOW_NAME],
      []
    );
    const html = renderAddRecordFields(workflow, [project, otherProject], {
      projectId: project.id
    }, generatedTasks);
    assert.ok(html.indexOf('name="projectId"') < html.indexOf('关联剧本任务'));
    assert.ok(html.includes('>请选择剧本创作任务</option>'));
    assert.ok(html.includes(`value="${screenplay.id}" data-project-id="${project.id}"`));
    assert.ok(html.includes(`value="${otherProjectScreenplay.id}" data-project-id="${otherProject.id}" hidden`));
    assert.ok(!html.includes(unrelatedTask.id));
    assert.ok(!html.includes('name="taskName"'));

    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();
    try {
      submissions.set(workflow.toolName, {
        screenplayTaskId: screenplay.id,
        aspectRatio: '9:16',
        visualStyle: '',
        additionalInfo: ''
      }, undefined, project.id);
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const response = result.content[0];
      assert.ok(response instanceof vscode.LanguageModelTextPart);
      const parameters = JSON.parse(response.value).parameters;
      assert.deepStrictEqual(parameters, {
        aspectRatio: '9:16',
        visualStyle: '',
        additionalInfo: '',
        scriptSource: '剧本完整正文'
      });

      const postedMessages: unknown[] = [];
      const panel = {
        title: '',
        webview: {
          postMessage: (message: unknown) => {
            postedMessages.push(message);
            return Promise.resolve(true);
          }
        },
        dispose: () => undefined
      } as unknown as vscode.WebviewPanel;
      const session = {
        key: workflow.toolName,
        panel,
        subscriptions: [],
        categoryId: workflow.toolName,
        viewMode: 'records' as const,
        projectFilter: project.id,
        ready: true,
        pendingAddRecordCategoryId: undefined,
        pendingProjectDialog: undefined
      };
      const view = new PromptRecordsViewProvider(database, formWorkflows, vscode.Uri.file(temporaryDirectory), submissions);
      const internalView = view as unknown as {
        panels: Map<string, typeof session>;
        saveAddedRecord: (message: unknown, targetSession: typeof session) => void;
        editRecord: (recordId: string | undefined, targetSession: typeof session) => void;
      };
      internalView.panels.set(session.key, session);
      try {
        internalView.saveAddedRecord({
          categoryId: workflow.toolName,
          projectId: project.id,
          values: {
            screenplayTaskId: screenplay.id,
            aspectRatio: '16:9',
            visualStyle: '',
            additionalInfo: ''
          }
        }, session);
        const shootingRecord = database.listRecords(SHOOTING_SCRIPT_WORKFLOW_NAME)[0];
        assert.ok(shootingRecord);
        assert.strictEqual(shootingRecord.taskName, '');
        assert.strictEqual((shootingRecord.data as Record<string, string>).taskName, undefined);
        const states = postedMessages.filter((message): message is {
          command: string;
          records: Array<{ id: string; taskName: string }>;
        } => typeof message === 'object' && message !== null && 'command' in message && message.command === 'state');
        const latestState = states[states.length - 1];
        assert.strictEqual(
          latestState?.records.find((record) => record.id === shootingRecord.id)?.taskName,
          '关联的内容任务'
        );

        internalView.editRecord(shootingRecord.id, session);
        const editDialog = postedMessages.find((message): message is { command: string; formFields: string } =>
          typeof message === 'object' && message !== null && 'command' in message &&
          message.command === 'open-add-record-dialog'
        );
        assert.ok(editDialog);
        assert.ok(!editDialog.formFields.includes('name="taskName"'));
      } finally {
        view.dispose();
      }
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('列表添加对话框渲染任务字段并复用工作流校验', () => {
    const workflow = formWorkflows.find((item) => item.toolName === CREATIVE_WRITING_WORKFLOW_NAME);
    const imageWorkflow = formWorkflows.find((item) => item.toolName === IMAGE_INSPIRED_WRITING_WORKFLOW_NAME);
    assert.ok(workflow);
    assert.ok(imageWorkflow);
    assert.ok([workflow, imageWorkflow].every((item) =>
      item.fields.some((field) => field.name === 'taskName' && field.label === '任务名称')
    ));

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
    assert.ok(html.includes('name="taskName"'));
    assert.ok(html.includes('name="chapterMinWords"'));
    assert.ok(html.includes('name="chapterMaxWords"'));
    assert.ok(html.includes('name="maxChapters"'));
    assert.ok(/name="chapterMinWords"[^>]*value="100"/.test(html));
    assert.ok(/name="chapterMaxWords"[^>]*value="2500"/.test(html));
    assert.ok(/name="maxChapters"[^>]*value="20"/.test(html));

    const editHtml = renderAddRecordFields(workflow, [project], {
      taskName: '预填任务',
      idea: '已保存的灵感',
      projectId: project.id
    });
    assert.ok(editHtml.includes('<option value="project-id" selected>&lt;项目&gt;</option>'));
    assert.ok(editHtml.includes('>预填任务</textarea>'));
    assert.ok(editHtml.includes('>已保存的灵感</textarea>'));

    const values = Object.fromEntries(workflow.fields.map((field) => [
      field.name,
      field.name === 'taskName' ? '列表新增任务' :
        field.name === 'chapterMinWords' ? '100' :
          field.name === 'chapterMaxWords' ? '2500' :
            field.name === 'maxChapters' ? '20' : field.required ? '1' : ''
    ]));
    assert.deepStrictEqual(validateWorkflowFormValues(values, workflow), values);
    assert.deepStrictEqual(
      validateWorkflowFormValues({ ...values, chapterMinWords: '100', chapterMaxWords: '100' }, workflow),
      { ...values, chapterMinWords: '100', chapterMaxWords: '100' }
    );
    assert.strictEqual(
      validateWorkflowFormValues({ ...values, chapterMinWords: '99' }, workflow),
      undefined
    );
    assert.strictEqual(
      validateWorkflowFormValues({ ...values, chapterMinWords: '2500', chapterMaxWords: '1500' }, workflow),
      undefined
    );
    assert.strictEqual(
      validateWorkflowFormValues({ ...values, taskName: '' }, workflow),
      undefined
    );

    const imageHtml = renderAddRecordFields(imageWorkflow, []);
    assert.ok(imageHtml.includes('id="add-image-file-input"'));
    const taskNamePosition = imageHtml.indexOf('name="taskName"');
    const attachmentPosition = imageHtml.indexOf('class="add-image-area"');
    const genrePosition = imageHtml.indexOf('name="genre"');
    assert.ok(taskNamePosition >= 0 && taskNamePosition < attachmentPosition && attachmentPosition < genrePosition);
    assert.ok(imageHtml.includes(`name="${IMAGE_ATTACHMENTS_FIELD}"`));
    assert.ok(imageHtml.includes('<select id="genre" name="genre" data-custom-input="genre-custom">'));
    assert.ok(imageHtml.includes('<div class="select-with-custom custom-input-below">'));
    assert.ok(imageHtml.includes('<option value="__custom__">其他</option>'));
    assert.ok(imageHtml.indexOf('<option value="恐怖">恐怖</option>') < imageHtml.indexOf('<option value="__custom__">其他</option>'));
    assert.ok(imageHtml.includes('id="genre-custom" name="genre__custom"'));
    const customGenreHtml = renderAddRecordFields(imageWorkflow, [], { genre: '蒸汽朋克' });
    assert.ok(customGenreHtml.includes('<option value="__custom__" selected>其他</option>'));
    assert.ok(customGenreHtml.includes('name="genre__custom" type="text" placeholder="输入自定义内容" value="蒸汽朋克"'));
    const imageEditHtml = renderAddRecordFields(imageWorkflow, [], {
      taskName: '保留图片的记录',
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
        taskName: '示例记录',
        categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
        categoryName: '创意写作',
        schema: [
          { name: 'taskName', label: '任务名称', required: true },
          { name: 'genre', label: '题材' }
        ],
        data: { taskName: '示例记录', genre: '科幻' }
      });

      assert.ok(fs.existsSync(path.join(storagePath, 'creative-projects.sqlite')));
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
        taskName: '修改后的记录',
        projectId: record.projectId,
        schema: record.schema,
        data: { taskName: '修改后的记录', genre: '奇幻' }
      });
      assert.ok(updatedRecord);
      assert.strictEqual(updatedRecord.taskName, '修改后的记录');
      assert.strictEqual(updatedRecord.generatedResultChinese, '中文提示词正文');
      assert.strictEqual(updatedRecord.generatedResultEnglish, 'English prompt body');
      assert.strictEqual(updatedRecord.createdAt, record.createdAt);
      assert.deepStrictEqual(updatedRecord.data, { taskName: '修改后的记录', genre: '奇幻' });
      assert.strictEqual(database.deleteRecord(record.id), true);
      assert.strictEqual(database.getRecord(record.id), undefined);
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
        taskName: '项目记录',
        categoryId: 'story',
        categoryName: '文字作品',
        projectId: project.id,
        schema: [],
        data: { taskName: '项目记录' }
      });
      const unassignedRecord = database.saveRecord({
        taskName: '独立记录',
        categoryId: 'story',
        categoryName: '文字作品',
        projectId: '0',
        schema: [],
        data: { taskName: '独立记录' }
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
        taskName: '相遇',
        categoryId: 'story',
        categoryName: '创意写作',
        projectId: project.id,
        schema: [],
        data: { taskName: '相遇' }
      });
      const duplicateCategoryRecord = database.saveRecord({
        taskName: '相遇的另一个版本',
        categoryId: 'story',
        categoryName: '创意写作',
        projectId: project.id,
        schema: [],
        data: { taskName: '相遇的另一个版本' }
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
      taskName: '含图片的创作记录',
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      schema: workflow.fields,
      data: {
        taskName: '含图片的创作记录',
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
        taskName: '编辑后的图片创作记录',
        projectId: record.projectId,
        schema: workflow.fields,
        data: { ...restoredValues, taskName: '编辑后的图片创作记录' }
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

  test('小说原作文件会保存、恢复并在任务表单中显示文件名', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-novel-source-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    let database = await PromptDatabase.open(vscode.Uri.file(storagePath));
    const workflow = formWorkflows.find((item) => item.toolName === NOVEL_RECREATION_WORKFLOW_NAME);
    assert.ok(workflow);
    const sourceFile = { name: '原作.md', content: '# 原作\n主角收到一封来自未来的信。' };
    const values = {
      taskName: '小说改编',
      [ORIGINAL_SOURCE_FILE_FIELD]: JSON.stringify(sourceFile)
    };
    const record = database.saveRecord({
      taskName: '小说改编',
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      schema: workflow.fields,
      data: values
    });

    try {
      const html = renderAddRecordFields(workflow, [], values);
      assert.ok(html.indexOf('name="taskName"') < html.indexOf(`name="${ORIGINAL_SOURCE_FILE_FIELD}"`));
      assert.ok(html.includes(`原作.md (${formatOriginalSourceFileSize(Buffer.byteLength(sourceFile.content, 'utf8'))})`));
      assert.strictEqual(formatOriginalSourceFileSize(512), '0.5 KB');
      assert.strictEqual(formatOriginalSourceFileSize(1024 * 1024 - 1), '1024.0 KB');
      assert.strictEqual(formatOriginalSourceFileSize(1024 * 1024), '1.00 MB');
      assert.strictEqual(formatOriginalSourceFileSize(1024 * 1024 * 1.5), '1.50 MB');
      assert.deepStrictEqual(parseOriginalSourceFile(values[ORIGINAL_SOURCE_FILE_FIELD]), sourceFile);
      assert.throws(
        () => parseOriginalSourceFile(JSON.stringify({ name: '原作.pdf', content: '正文' })),
        /仅支持有效的 TXT 或 Markdown/
      );

      database.dispose();
      database = await PromptDatabase.open(vscode.Uri.file(storagePath));
      const restoredRecord = database.getRecord(record.id);
      assert.ok(restoredRecord);
      assert.deepStrictEqual(
        parseOriginalSourceFile((restoredRecord.data as Record<string, string>)[ORIGINAL_SOURCE_FILE_FIELD]),
        sourceFile
      );
    } finally {
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('小说原作正文与其他参数一并发送给 Copilot', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-novel-submission-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const workflow = formWorkflows.find((item) => item.toolName === NOVEL_RECREATION_WORKFLOW_NAME);
    assert.ok(workflow);
    const sourceFile = { name: '故事.txt', content: '这是用于改编的原作正文。' };
    const values = {
      taskName: '改编任务',
      target: '单章',
      chapterMinWords: '200',
      chapterMaxWords: '2500',
      maxChapters: '3',
      preserve: '保留主角和结局',
      adjustments: '',
      additionalInfo: '保持悬疑氛围',
      [ORIGINAL_SOURCE_FILE_FIELD]: JSON.stringify(sourceFile)
    };
    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      submissions.set(workflow.toolName, values, 'novel-record');
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const textPart = result.content[0];
      assert.ok(textPart instanceof vscode.LanguageModelTextPart);
      const parameters = JSON.parse(textPart.value).parameters;
      assert.strictEqual(parameters.sourceMaterial, sourceFile.content);
      assert.strictEqual(parameters.sourceFileName, sourceFile.name);
      assert.strictEqual(parameters.additionalInfo, '保持悬疑氛围');
      assert.strictEqual(parameters.taskName, undefined);
      assert.strictEqual(parameters[ORIGINAL_SOURCE_FILE_FIELD], undefined);

      submissions.set(workflow.toolName, { ...values, [ORIGINAL_SOURCE_FILE_FIELD]: '' }, 'novel-record');
      await assert.rejects(
        tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token),
        /请先上传原作 TXT 或 Markdown 文件/
      );
    } finally {
      cancellationSource.dispose();
      database.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('能够将记录页提交的参数一次性交给工作流工具', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-submission-'));
    let database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const workflow = formWorkflows[0];
    const values = { taskName: '已选记录', idea: '灯塔收到未来的信号' };
    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      submissions.set(workflow.toolName, values, 'saved-record-id');
      assert.throws(
        () => submissions.set(workflow.toolName, { taskName: '不应覆盖' }, 'other-record-id'),
        /已有待处理的运行请求/
      );
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const response = result.content[0];
      assert.ok(response instanceof vscode.LanguageModelTextPart);
      assert.deepStrictEqual(JSON.parse(response.value).parameters, { idea: '灯塔收到未来的信号' });
      assert.strictEqual(values.taskName, '已选记录');
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
      taskName: '分集创意',
      categoryId: CREATIVE_WRITING_WORKFLOW_NAME,
      categoryName: '创意写作',
      projectId: project.id,
      schema: [],
      data: { taskName: '分集创意' }
    });
    database.replaceGeneratedOutput(sourceRecord.id, { type: 'chapters', chapters: [
      { chapterNumber: 1, title: '第一集', content: '第一集完整正文' },
      { chapterNumber: 2, title: '第二集', content: '第二集完整正文' }
    ] });
    database.updateGeneratedContent(sourceRecord.id, '不应混入的整段正文');
    const workflow = formWorkflows.find((item) => item.toolName === SCREENPLAY_WORKFLOW_NAME);
    assert.ok(workflow);
    assert.ok(!workflow.fields.some((field) => field.name === 'sourceMaterial'));
    const submissions = new WorkflowSubmissionStore();
    const tool = new WorkflowFormTool(workflow, database, submissions);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      submissions.set(workflow.toolName, {
        taskName: '改编剧本',
        sourceTaskId: sourceRecord.id,
        sourceMaterial: '不应使用的旧手填素材',
        maxEpisodeDurationSeconds: '60',
        maxEpisodes: '2',
        additionalInfo: ''
      }, undefined, project.id);
      const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token);
      const textPart = result.content[0];
      assert.ok(textPart instanceof vscode.LanguageModelTextPart);
      const parameters = JSON.parse(textPart.value).parameters;
      assert.deepStrictEqual(JSON.parse(parameters.sourceMaterial), [
        { chapterNumber: 1, title: '第一集', content: '第一集完整正文' },
        { chapterNumber: 2, title: '第二集', content: '第二集完整正文' }
      ]);
      assert.strictEqual(parameters.taskName, undefined);
      assert.strictEqual(parameters.sourceTaskId, undefined);
      assert.strictEqual(parameters.maxEpisodeDurationSeconds, 60);
      assert.strictEqual(parameters.maxEpisodes, 2);
      assert.strictEqual(parameters.genre, undefined);
      assert.strictEqual(parameters.style, undefined);
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
      taskName: '图片参考',
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
      assert.deepStrictEqual(JSON.parse(textPart.value).parameters, {});
      assert.ok(imagePart instanceof vscode.LanguageModelDataPart);
      assert.strictEqual(imagePart.mimeType, 'image/png');
      assert.deepStrictEqual(Buffer.from(imagePart.data), imageBytes);

      submissions.set(workflow.toolName, {
        taskName: '缺少图片',
        [IMAGE_ATTACHMENTS_FIELD]: '[]'
      });
      await assert.rejects(
        tool.invoke({ input: {}, toolInvocationToken: undefined }, cancellationSource.token),
        /图片灵感写作至少需要添加一张图片/
      );
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
      taskName: '待生成记录',
      categoryId: 'ai-video-creation-tools_collect_character_parameters',
      categoryName: '创意写作',
      schema: [],
      data: { taskName: '待生成记录' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      database.replaceGeneratedOutput(record.id, { type: 'chapters', chapters: [
        { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
      ] });
      database.updateGeneratedContent(record.id, '上次生成的单篇正文');
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
      taskName: '待生成作品',
      categoryId: IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
      categoryName: '图片灵感写作',
      schema: [],
      data: { taskName: '待生成作品', chapterMinWords: '500', chapterMaxWords: '500', maxChapters: '2' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      database.replaceGeneratedOutput(record.id, { type: 'chapters', chapters: [
        { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
      ] });
      database.updateGeneratedContent(record.id, '上次生成的单篇正文');
      database.updateGeneratedResult(record.id, '上次中文提示词', 'Previous English prompt');
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
        /第 1 章正文统计为 499 字，必须在 500 到 500 字之间/
      );
      const result = await tool.invoke({
        input: { recordId: record.id, chapters: generatedChapters },
        toolInvocationToken: undefined
      }, cancellationSource.token);
      const textPart = result.content[0];
      assert.ok(textPart instanceof vscode.LanguageModelTextPart);
      assert.deepStrictEqual(JSON.parse(textPart.value), { status: 'saved', recordId: record.id });
      const savedRecord = database.getRecord(record.id);
      assert.strictEqual(savedRecord?.generatedResultContent, undefined);
      assert.strictEqual(savedRecord?.generatedResultChinese, undefined);
      assert.strictEqual(savedRecord?.generatedResultEnglish, undefined);
      assert.ok(savedRecord?.generatedAt);
      assert.deepStrictEqual(database.listGeneratedChapterContents(record.id), generatedChapters);
      const largeChapterRecord = database.saveRecord({
        taskName: '超过原上限章节',
        categoryId: IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
        categoryName: '图片灵感写作',
        schema: [],
        data: { taskName: '超过原上限章节', chapterMinWords: '100', chapterMaxWords: '25001', maxChapters: '1' }
      });
      await tool.invoke({
        input: {
          recordId: largeChapterRecord.id,
          chapters: [{ chapterNumber: 1, title: '长章节', content: '长'.repeat(20001) }]
        },
        toolInvocationToken: undefined
      }, cancellationSource.token);
      assert.strictEqual(database.listGeneratedChapterContents(largeChapterRecord.id)[0].content.length, 20001);
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
          taskName: workflow.title,
          categoryId: workflow.toolName,
          categoryName: workflow.title,
          schema: [],
          data: { taskName: workflow.title }
        });
        database.replaceGeneratedOutput(record.id, { type: 'chapters', chapters: [
          { chapterNumber: 1, title: '旧章节', content: '上次生成的章节正文' }
        ] });
        database.updateGeneratedResult(record.id, '上次中文提示词', 'Previous English prompt');
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
      taskName: '双语拍摄脚本',
      categoryId: SHOOTING_SCRIPT_WORKFLOW_NAME,
      categoryName: '拍摄脚本制作',
      schema: [],
      data: { taskName: '双语拍摄脚本' }
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
    const assetTaskNameFields = formWorkflows
      .filter((workflow) => [
        'ai-video-creation-tools_collect_character_parameters',
        'ai-video-creation-tools_collect_scene_parameters',
        'ai-video-creation-tools_collect_prop_parameters',
        'ai-video-creation-tools_collect_effect_parameters'
      ].includes(workflow.toolName))
      .map((workflow) => workflow.fields.find((field) => field.name === 'taskName'));
    assert.deepStrictEqual(
      assetTaskNameFields.map((field) => field?.label),
      ['角色名称', '场景名称', '道具名称', '特效名称']
    );
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
    assert.strictEqual(contributions.chatSkills, undefined);
    assert.strictEqual(contributions.chatPromptFiles.length, 9);
    const extensionRoot = extension.extensionUri.fsPath;
    const contributedPaths = [
      ...contributions.chatAgents,
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
        'taskName', 'idea', 'genre', 'chapterMinWords', 'chapterMaxWords', 'maxChapters', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_image_inspired_writing_parameters': [
        'taskName', 'genre', 'chapterMinWords', 'chapterMaxWords', 'maxChapters', 'visualElements', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_novel_parameters': [
        'taskName', 'target', 'chapterMinWords', 'chapterMaxWords', 'maxChapters', 'preserve', 'adjustments', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_character_parameters': [
        'taskName', 'characterType', 'appearance', 'clothing', 'expressionPose', 'composition', 'style', 'background', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_scene_parameters': [
        'taskName', 'placeType', 'layout', 'environment', 'composition', 'style', 'background', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_prop_parameters': [
        'taskName', 'propName', 'appearance', 'state', 'composition', 'style', 'background', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_effect_parameters': [
        'taskName', 'source', 'appearance', 'motion', 'environmentInteraction', 'composition', 'style', 'background', 'aspectRatio', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_screenplay_parameters': [
        'sourceTaskId', 'maxEpisodeDurationSeconds', 'maxEpisodes', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_shooting_script_parameters': [
        'screenplayTaskId', 'aspectRatio', 'visualStyle', 'additionalInfo'
      ]
    };

    for (const [toolName, fieldNames] of Object.entries(expectedFieldNames)) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      assert.deepStrictEqual(workflow.fields.map((field) => field.name), fieldNames);
      assert.strictEqual(workflow.fields[0].required, true);
      assert.ok(workflow.fields.some((field) => field.name === 'additionalInfo'));
    }

    const novelWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_novel_parameters');
    assert.strictEqual(novelWorkflow?.fields.find((field) => field.name === 'target')?.label, '章节形式');
    assert.ok(novelWorkflow?.fields.find((field) => field.name === 'target')?.description.includes('章节数上限'));
    assert.deepStrictEqual(novelWorkflow?.fields.find((field) => field.name === 'target')?.options, ['单章', '分章']);
    assert.strictEqual(novelWorkflow?.fields.find((field) => field.name === 'target')?.allowCustom, undefined);

    const visualAssetWorkflowNames = [
      'ai-video-creation-tools_collect_character_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_effect_parameters'
    ];
    for (const toolName of visualAssetWorkflowNames) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      const visualFields = workflow.fields.filter((field) =>
        ['composition', 'style', 'background', 'aspectRatio'].includes(field.name)
      );
      assert.deepStrictEqual(visualFields.map((field) => field.label), ['视角与构图', '画面风格', '背景', '画幅比例']);
      assert.ok(visualFields.every((field) => Boolean(field.options?.length)));
      assert.ok(visualFields.slice(0, 3).every((field) => field.allowCustom));
    }

    const chapterContentWorkflows = formWorkflows.filter((workflow) => workflow.supportsChapterContent);
    assert.strictEqual(chapterContentWorkflows.length, 3);
    for (const workflow of chapterContentWorkflows) {
      const chapterMinWords = workflow.fields.find((field) => field.name === 'chapterMinWords');
      const chapterMaxWords = workflow.fields.find((field) => field.name === 'chapterMaxWords');
      const maxChapters = workflow.fields.find((field) => field.name === 'maxChapters');
      assert.strictEqual(chapterMinWords?.inputType, 'number');
      assert.strictEqual(chapterMinWords?.min, 100);
      assert.strictEqual(chapterMinWords?.required, true);
      assert.strictEqual(chapterMaxWords?.inputType, 'number');
      assert.strictEqual(chapterMaxWords?.min, 100);
      assert.strictEqual(chapterMaxWords?.max, undefined);
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
    const sceneWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_scene_parameters');
    assert.ok(sceneWorkflow?.fields.find((field) => field.name === 'style')?.options?.includes('建筑可视化'));
    assert.ok(sceneWorkflow?.fields.find((field) => field.name === 'background')?.options?.includes('完整环境场景'));
    const propWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_prop_parameters');
    assert.ok(propWorkflow?.fields.find((field) => field.name === 'background')?.options?.includes('纯白产品背景'));
    assert.ok(propWorkflow?.fields.find((field) => field.name === 'aspectRatio')?.options?.includes('1:1'));
    const effectWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_effect_parameters');
    assert.ok(effectWorkflow?.fields.find((field) => field.name === 'style')?.options?.includes('魔法粒子特效'));
    assert.ok(effectWorkflow?.fields.find((field) => field.name === 'background')?.options?.includes('透明背景'));

    const shootingScriptWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_shooting_script_parameters');
    assert.ok(shootingScriptWorkflow);
    assert.deepStrictEqual(
      shootingScriptWorkflow.fields.find((field) => field.name === 'visualStyle')?.options,
      ['写实电影风格', '写实摄影', '2D动漫插画', '3D动画风格', '游戏概念设计', '水彩插画', '黑白线稿']
    );
    assert.ok(!shootingScriptWorkflow.fields.some((field) => field.name === 'cameraStyle'));

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
    assert.ok(agentContent.includes('按用户指定的目标产物和当前制作阶段执行对应 Prompt'));
    assert.ok(agentContent.includes('按其交付要求呈现'));
    assert.ok(agentContent.includes('工具返回 `status: cancelled` 时停止本次任务'));
    assert.ok(agentContent.includes('返回 `status: submitted` 时从 `parameters` 读取已提交内容继续'));
    assert.ok(agentContent.includes('直接分析图片参数工具结果中的图片，不要求用户将同一图片另行附加到 Copilot 聊天'));
    assert.ok(agentContent.includes('创意写作、图片灵感写作、小说重创作、剧本创作和拍摄脚本制作'));
    assert.ok(agentContent.includes('创意写作、图片灵感写作和小说重创作使用 `chapters` 数组'));

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
      assert.ok(promptContent.includes('## 参数工具'));
      assert.ok(!promptContent.includes('status: cancelled'));
      assert.ok(!promptContent.includes('status: submitted'));
      assert.ok(!promptContent.includes('不要把参数列表输出为聊天文本'));
      assert.ok(!promptContent.includes('空字段'));
      if (promptName === 'character-generation.prompt.md') {
        assert.ok(promptContent.includes('角色类型和主体'));
        assert.ok(promptContent.includes('丧尸的腐坏特征'));
        assert.ok(promptContent.includes('独立使用的中文和英文图像生成提示词'));
      }
      if (['scene-generation.prompt.md', 'prop-generation.prompt.md', 'effect-generation.prompt.md'].includes(promptName)) {
        assert.ok(promptContent.includes('独立使用的中文和英文图像生成提示词'));
      }
      if (promptName === 'image-inspired-writing.prompt.md') {
        assert.ok(promptContent.includes('分别分析，不擅自建立人物或事件联系'));
      }
      if (promptName === 'creative-writing.prompt.md') {
        assert.ok(promptContent.includes('素材不足时宁可少写，不得重复情节、注水或补造设定来凑字数或章节'));
      }
      if (promptName === 'novel-adaptation.prompt.md') {
        assert.ok(promptContent.includes('`sourceMaterial` 是改编必需材料'));
      }
      if (promptName === 'screenplay.prompt.md') {
        assert.ok(promptContent.includes('交付完整剧本包，但不扩展成逐镜头拍摄计划'));
        assert.ok(promptContent.includes('## 剧本包交付格式'));
        assert.ok(promptContent.includes('### 三、角色设定'));
        assert.ok(promptContent.includes('### 四、场景设定'));
        assert.ok(promptContent.includes('### 五、关键道具与特效'));
        assert.ok(promptContent.includes('### 七、剧本正文'));
        assert.ok(promptContent.includes('### 八、连续性备注'));
        assert.ok(promptContent.includes('直接作为剧本采用设定写入设定表和正文'));
        assert.ok(promptContent.includes('不添加解释性前缀或标签'));
        assert.ok(!promptContent.includes('建议'));
        assert.ok(promptContent.includes('不询问是否采用'));
        assert.ok(promptContent.includes('输出前检查'));
      }
      if (promptName === 'shooting-script.prompt.md') {
        assert.ok(promptContent.includes('镜头时长合计应与之匹配'));
        assert.ok(promptContent.includes('镜头编号、场次、景别/视角'));
        assert.ok(promptContent.includes('可独立使用的视频生成提示词'));
        assert.ok(!promptContent.includes('镜头时长遵循素材或剧本'));
        assert.ok(!promptContent.includes('每个镜头均包含可单独用于视频生成的动态画面提示词'));
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
    const recordsPageSource = recordsViewSource.slice(recordsViewSource.indexOf('function createPageHtml('));
    assert.ok(recordsPageSource.includes('<span class="project-column">所属项目</span>'));
    assert.ok(recordsPageSource.includes('<div class="table-header" role="row"><span>项目名称</span><span>项目简介</span><span>创建时间</span><span>操作</span></div>'));
    assert.ok(recordsPageSource.includes("default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"));
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
    assert.ok(recordsViewSource.includes('<ol id="chapter-content-list" class="chapter-content-list" aria-label="章节内容列表"></ol>'));
    assert.ok(recordsViewSource.includes("number.textContent = '第 ' + chapter.chapterNumber + ' 章';"));
    assert.ok(recordsViewSource.includes('title.textContent = chapter.title;'));
    assert.ok(recordsViewSource.includes('content.textContent = chapter.content;'));
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
