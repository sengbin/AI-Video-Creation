import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { PromptDatabase } from '../../database';
import { parseImageAttachments } from '../../formPanel';
import {
  formWorkflows,
  IMAGE_ATTACHMENTS_FIELD,
  IMAGE_STORY_WORKFLOW_NAME,
  SHOOTING_SCRIPT_WORKFLOW_NAME
} from '../../formWorkflows';
import {
  GeneratedResultTool,
  SAVE_GENERATED_RESULT_TOOL_NAME,
  WorkflowFormTool,
  WorkflowSubmissionStore
} from '../../workflowFormTool';

suite('AI视频创作助手扩展', () => {
  test('首次打开时创建用户级数据库并保存动态模板记录', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-db-'));
    const storagePath = path.join(temporaryDirectory, 'globalStorage');
    let database = await PromptDatabase.open(vscode.Uri.file(storagePath));

    try {
      const record = database.saveRecord({
        title: '示例记录',
        categoryId: 'ai-video-creation-tools_collect_story_parameters',
        categoryName: '创意写故事',
        schema: [
          { name: 'title', label: '标题', required: true },
          { name: 'genre', label: '题材' }
        ],
        data: { title: '示例记录', genre: '科幻' }
      });

      assert.ok(fs.existsSync(path.join(storagePath, 'prompt-records.sqlite')));
      assert.deepStrictEqual(database.getRecord(record.id), record);
      assert.deepStrictEqual(
        database.listRecords('ai-video-creation-tools_collect_story_parameters'),
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
      const updatedRecord = database.updateRecord(record.id, {
        title: '修改后的记录',
        episodeId: record.episodeId,
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

  test('剧集可筛选记录并在删除时级联清理绑定数据', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-episodes-'));
    const database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    try {
      const episode = database.createEpisode({ name: '第一集', description: '开端' });
      const boundRecord = database.saveRecord({
        title: '剧集记录',
        categoryId: 'story',
        categoryName: '故事',
        episodeId: episode.id,
        schema: [],
        data: { title: '剧集记录' }
      });
      const unassignedRecord = database.saveRecord({
        title: '独立记录',
        categoryId: 'story',
        categoryName: '故事',
        episodeId: '0',
        schema: [],
        data: { title: '独立记录' }
      });

      assert.strictEqual(boundRecord.episodeId, episode.id);
      assert.deepStrictEqual(database.listRecords(undefined, episode.id), [boundRecord]);
      assert.deepStrictEqual(database.listRecords(undefined, '0'), [unassignedRecord]);
      assert.throws(() => database.createEpisode({ name: '第一集', description: '' }), /名称已存在/);
      assert.strictEqual(database.deleteEpisode(episode.id), true);
      assert.strictEqual(database.getRecord(boundRecord.id), undefined);
      assert.deepStrictEqual(database.listRecords(undefined, '0'), [unassignedRecord]);
      assert.deepStrictEqual(database.listEpisodes(), []);
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
      title: '含图片的故事记录',
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      schema: workflow.fields,
      data: {
        title: '含图片的故事记录',
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
        title: '编辑后的图片故事记录',
        episodeId: record.episodeId,
        schema: workflow.fields,
        data: { ...restoredValues, title: '编辑后的图片故事记录' }
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
      assert.strictEqual(record.episodeId, '0');
      assert.strictEqual(record.updatedAt, record.createdAt);
      assert.strictEqual(record.generatedResultChinese, '旧版中英合并提示词');
      assert.strictEqual(record.generatedResultEnglish, undefined);
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

  test('能够将图片写故事附件作为图像内容交给 Copilot', async () => {
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
      categoryName: '创意写故事',
      schema: [],
      data: { title: '待生成记录' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
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

  test('图片写故事只保存并恢复单篇故事正文', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-story-result-'));
    let database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
    const record = database.saveRecord({
      title: '待生成故事',
      categoryId: IMAGE_STORY_WORKFLOW_NAME,
      categoryName: '图片写故事',
      schema: [],
      data: { title: '待生成故事' }
    });
    const tool = new GeneratedResultTool(database);
    const cancellationSource = new vscode.CancellationTokenSource();

    try {
      await tool.invoke({
        input: { recordId: record.id, content: '雨夜里，旧照片上的灯塔亮了起来。' },
        toolInvocationToken: undefined
      }, cancellationSource.token);
      const savedRecord = database.getRecord(record.id);
      assert.strictEqual(savedRecord?.generatedResultContent, '雨夜里，旧照片上的灯塔亮了起来。');
      assert.strictEqual(savedRecord?.generatedResultChinese, undefined);
      assert.strictEqual(savedRecord?.generatedResultEnglish, undefined);
      await assert.rejects(
        tool.invoke({
          input: {
            recordId: record.id,
            content: '不得同时提交提示词字段',
            contentZh: '不得保存为提示词',
            contentEn: 'Must not save as prompts'
          },
          toolInvocationToken: undefined
        }, cancellationSource.token),
        /只能提交单篇创作内容/
      );
      database.dispose();
      database = await PromptDatabase.open(vscode.Uri.file(path.join(temporaryDirectory, 'globalStorage')));
      assert.strictEqual(database.getRecord(record.id)?.generatedResultContent, '雨夜里，旧照片上的灯塔亮了起来。');
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
      workflow.toolName !== IMAGE_STORY_WORKFLOW_NAME &&
      workflow.toolName !== SHOOTING_SCRIPT_WORKFLOW_NAME
    );

    try {
      assert.deepStrictEqual(contentWorkflows.map((workflow) => workflow.title), [
        '创意写故事', '小说重创作', '剧本创作'
      ]);
      for (const workflow of contentWorkflows) {
        const record = database.saveRecord({
          title: workflow.title,
          categoryId: workflow.toolName,
          categoryName: workflow.title,
          schema: [],
          data: { title: workflow.title }
        });
        const generatedContent = `${workflow.title}的完整作品内容`;
        await tool.invoke({
          input: { recordId: record.id, content: generatedContent },
          toolInvocationToken: undefined
        }, cancellationSource.token);

        const savedRecord = database.getRecord(record.id);
        assert.strictEqual(savedRecord?.generatedResultContent, generatedContent);
        assert.strictEqual(savedRecord?.generatedResultChinese, undefined);
        assert.strictEqual(savedRecord?.generatedResultEnglish, undefined);
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
      'ai-video-creation-tools_collect_effect_parameters',
      'ai-video-creation-tools_collect_image_story_parameters',
      'ai-video-creation-tools_collect_novel_parameters',
      'ai-video-creation-tools_collect_prop_parameters',
      'ai-video-creation-tools_collect_scene_parameters',
      'ai-video-creation-tools_collect_screenplay_parameters',
      'ai-video-creation-tools_collect_shooting_script_parameters',
      'ai-video-creation-tools_collect_story_parameters'
    ]);
    assert.ok(vscode.lm.tools.some((tool) => tool.name === SAVE_GENERATED_RESULT_TOOL_NAME));

    const contributions = extension.packageJSON.contributes;
    assert.strictEqual(
      contributions.configurationDefaults['github.copilot.chat.imageUpload.enabled'],
      false
    );
    const expectedWorkflowOrder = [
      'ai-video-creation-tools_collect_story_parameters',
      'ai-video-creation-tools_collect_image_story_parameters',
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
      ['创意写故事', '图片写故事', '小说重创作', '剧本创作', '拍摄脚本制作']
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
        'creative-story.prompt.md',
        'image-story.prompt.md',
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
      'ai-video-creation-tools_collect_story_parameters': [
        'title', 'idea', 'genre', 'duration', 'style', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_image_story_parameters': [
        'title', 'genre', 'duration', 'visualElements', 'additionalInfo'
      ],
      'ai-video-creation-tools_collect_novel_parameters': [
        'title', 'target', 'scope', 'preserve', 'adjustments', 'additionalInfo'
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
        'title', 'sourceMaterial', 'format', 'genre', 'duration', 'additionalInfo'
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
    assert.ok(agentContent.includes('创意写故事、图片写故事、小说重创作、剧本创作和拍摄脚本制作'));
    assert.ok(agentContent.includes('直接创作的作品使用 `content`，视觉资产提示词使用 `contentZh` 和 `contentEn`'));

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
      ['creative-story.prompt.md', 'ai-video-creation-tools_collect_story_parameters', '## 任务'],
      ['image-story.prompt.md', 'ai-video-creation-tools_collect_image_story_parameters', '## 图片关系'],
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
      if (promptName === 'image-story.prompt.md') {
        assert.ok(promptContent.includes('分别分析，不擅自建立人物或事件联系'));
      }
      if (promptName === 'creative-story.prompt.md') {
        assert.ok(promptContent.includes('未指定形式时，默认交付完整连贯的故事正文'));
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
    assert.strictEqual(saveResultContribution.inputSchema.oneOf.length, 2);
    const recordsViewSource = fs.readFileSync(path.join(extensionRoot, 'src', 'promptRecordsView.ts'), 'utf8');
    assert.ok(recordsViewSource.includes("const resultLabel = '查看'"));
    assert.ok(recordsViewSource.includes('id="generated-content" aria-label="生成内容"'));
    assert.ok(recordsViewSource.includes("'bilingual-content'"));
    assert.ok(recordsViewSource.includes("isScreenplay ? '剧本内容' : '生成内容'"));
    assert.ok(recordsViewSource.includes("isShootingScript ? '拍摄脚本提示词' : '中文提示词'"));
    assert.ok(recordsViewSource.includes("isShootingScript ? 'Shooting Script Prompt' : 'English Prompt'"));
    assert.ok(recordsViewSource.includes('id="prompt-result-fields" hidden'));
  });
});
