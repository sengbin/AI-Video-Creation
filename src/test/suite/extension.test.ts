import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { formWorkflows } from '../../formWorkflows';

suite('AI 视频创作工具扩展', () => {
  test('能够激活扩展并注册九个参数表单工具', async () => {
    const extension = vscode.extensions.getExtension('chengbin.ai-video-creation-tools');

    if (!extension) {
      throw new Error('未找到 AI 视频创作工具扩展。');
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

    const contributions = extension.packageJSON.contributes;
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
        'idea', 'theme', 'genre', 'duration', 'episodeCount', 'era', 'characterCount', 'style', 'ending', 'boundaries', 'deliverable', 'phase'
      ],
      'ai-video-creation-tools_collect_image_story_parameters': [
        'genre', 'duration', 'episodeCount', 'protagonist', 'relationships', 'storyType', 'tone', 'ending', 'visualElements', 'deliverable', 'phase', 'imageOrder', 'imageRelationships'
      ],
      'ai-video-creation-tools_collect_novel_parameters': [
        'target', 'scope', 'positioning', 'style', 'preserve', 'adjustments', 'ending', 'deliverable', 'phase'
      ],
      'ai-video-creation-tools_collect_screenplay_parameters': [
        'sourceMaterial', 'format', 'genre', 'duration', 'audience', 'theme', 'characters', 'coreConflict', 'mustKeep', 'allowedChanges', 'tone', 'ending', 'deliverable', 'boundaries'
      ],
      'ai-video-creation-tools_collect_shooting_script_parameters': [
        'scriptSource', 'duration', 'aspectRatio', 'shotCount', 'shotDuration', 'visualStyle', 'cameraStyle', 'continuity', 'audio', 'generationModel', 'deliverable', 'constraints'
      ],
      'ai-video-creation-tools_collect_character_parameters': [
        'name', 'characterType', 'age', 'gender', 'appearance', 'body', 'hairstyle', 'clothing', 'distinctiveFeatures', 'expressionPose', 'composition', 'style', 'background', 'aspectRatio', 'toolLimits'
      ],
      'ai-video-creation-tools_collect_scene_parameters': [
        'placeType', 'era', 'region', 'spaceSize', 'layout', 'entrances', 'fixtures', 'time', 'weather', 'light', 'atmosphere', 'style', 'aspectRatio', 'toolLimits'
      ],
      'ai-video-creation-tools_collect_prop_parameters': [
        'propName', 'era', 'size', 'material', 'color', 'structure', 'ability', 'state', 'style', 'toolLimits'
      ],
      'ai-video-creation-tools_collect_effect_parameters': [
        'source', 'trigger', 'location', 'duration', 'movementDirection', 'range', 'color', 'brightness', 'form', 'intensity', 'environmentInteraction', 'cameraView', 'style', 'toolLimits'
      ]
    };

    for (const [toolName, fieldNames] of Object.entries(expectedFieldNames)) {
      const workflow = formWorkflows.find((item) => item.toolName === toolName);
      assert.ok(workflow);
      assert.deepStrictEqual(workflow.fields.map((field) => field.name), fieldNames);
    }

    const characterWorkflow = formWorkflows.find((item) => item.toolName === 'ai-video-creation-tools_collect_character_parameters');
    assert.ok(characterWorkflow);
    assert.deepStrictEqual(
      characterWorkflow.fields.find((field) => field.name === 'characterType')?.options,
      ['人类', '动物', '怪物', '丧尸', '其他']
    );

    assert.ok(formWorkflows.every((workflow) => workflow.fields
      .filter((field) => !field.options)
      .every((field) => Boolean(field.placeholder))));

    const agentPath = path.join(extensionRoot, contributions.chatAgents[0].path);
    const agentContent = fs.readFileSync(agentPath, 'utf8');
    const agentFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agentContent);
    assert.ok(agentFrontmatter);
    assert.strictEqual(parseYaml(agentFrontmatter[1]).name, 'AI 视频创作（扩展）智能体');
    assert.ok(agentContent.includes('如果当前会话未加载该 Skill 或无法使用其规则，立即停止；不得调用参数表单工具或继续生成'));

    const skillPath = path.join(extensionRoot, contributions.chatSkills[0].path);
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const skillFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillContent);
    assert.ok(skillFrontmatter);
    assert.strictEqual(parseYaml(skillFrontmatter[1]).name, 'ai-video-prompt-design');
    assert.ok(skillContent.includes('拍摄脚本生成提示词结构'));

    const promptTools = [
      ['创意写故事.prompt.md', 'ai-video-creation-tools_collect_story_parameters', '## 创作目标'],
      ['图片写故事.prompt.md', 'ai-video-creation-tools_collect_image_story_parameters', '## 看图提示词设计流程'],
      ['小说重创作.prompt.md', 'ai-video-creation-tools_collect_novel_parameters', '## 改编提示词设计流程'],
      ['剧本创作.prompt.md', 'ai-video-creation-tools_collect_screenplay_parameters', '## 剧本提示词设计流程'],
      ['拍摄脚本制作.prompt.md', 'ai-video-creation-tools_collect_shooting_script_parameters', '## 拍摄提示词设计流程'],
      ['角色生成.prompt.md', 'ai-video-creation-tools_collect_character_parameters', '## 角色设定流程'],
      ['场景生成.prompt.md', 'ai-video-creation-tools_collect_scene_parameters', '## 场景设定流程'],
      ['道具生成.prompt.md', 'ai-video-creation-tools_collect_prop_parameters', '## 道具设定流程'],
      ['特效生成.prompt.md', 'ai-video-creation-tools_collect_effect_parameters', '## 特效设定流程']
    ];

    for (const [promptName, toolName, domainInstructionsHeading] of promptTools) {
      const promptPath = path.join(extensionRoot, 'copilot-customizations', 'prompts', promptName);
      const promptContent = fs.readFileSync(promptPath, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(promptContent);
      assert.ok(frontmatter);
      const metadata = parseYaml(frontmatter[1]);
      assert.strictEqual(metadata.agent, 'AI 视频创作（扩展）智能体');
      assert.strictEqual(metadata.tools, undefined);
      assert.ok(promptContent.includes(`必须调用一次 \`${toolName}\``));
      assert.ok(promptContent.includes('## 使用范围'));
      assert.ok(promptContent.includes('本 Prompt 用于'));
      assert.ok(promptContent.includes(domainInstructionsHeading));
      assert.ok(!promptContent.includes('ai-video-prompt-design'));
      assert.ok(promptContent.includes('代码块'));
      if (promptName === '角色生成.prompt.md') {
        assert.ok(promptContent.includes('角色类型和主体'));
        assert.ok(promptContent.includes('丧尸的腐坏特征'));
      }
    }
  });
});
