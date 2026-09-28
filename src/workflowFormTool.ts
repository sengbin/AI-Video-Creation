import * as vscode from 'vscode';
import { PromptDatabase } from './database';
import {
  countChapterWords,
  GeneratedChapterContent,
  MAX_CHAPTER_WORDS,
  MAX_GENERATED_CHAPTERS,
  MIN_CHAPTER_WORDS
} from './chapterContent';
import { collectFormValues, parseImageAttachments } from './formPanel';
import {
  FormValues,
  FormWorkflow,
  formWorkflows,
  getWorkflowResultType,
  isChapterContentWorkflow,
  IMAGE_ATTACHMENTS_FIELD,
  SCREENPLAY_WORKFLOW_NAME,
  SHOOTING_SCRIPT_WORKFLOW_NAME
} from './formWorkflows';

type EmptyToolInput = Record<string, never>;

function listGeneratedContentTasks(database: PromptDatabase) {
  const contentWorkflows = formWorkflows.filter((workflow) => workflow.resultType === 'content');
  return database.listGeneratedContentTasks(
    contentWorkflows.map((workflow) => workflow.toolName),
    contentWorkflows
      .filter((workflow) => workflow.supportsChapterContent === true)
      .map((workflow) => workflow.toolName)
  );
}

/** 等待工作流参数工具读取的已提交表单与记录关联信息。 */
export interface WorkflowSubmission {
  /** 已提交的表单数据。 */
  readonly values: FormValues;
  /** 与表单关联的提示词记录标识。 */
  readonly recordId?: string;
  /** 与表单关联的项目标识；'0' 表示未归属项目。 */
  readonly projectId: string;
}

/** 保存生成结果工具接收的参数。 */
export interface SaveGeneratedResultInput {
  /** 参数工具结果提供的提示词记录标识。 */
  readonly recordId: string;
  /** 作品类工作流返回的完整创作内容。 */
  readonly content?: string;
  /** 按章拆分的创作内容。 */
  readonly chapters?: readonly GeneratedChapterContent[];
  /** 提示词类工作流返回的完整中文提示词。 */
  readonly contentZh?: string;
  /** 提示词类工作流返回的完整英文提示词。 */
  readonly contentEn?: string;
}

/** 生成结果保存工具的注册名称。 */
export const SAVE_GENERATED_RESULT_TOOL_NAME = 'ai-video-creation-tools_save_generated_result';

/** 保存并交接记录页面已提交的工作流参数。 */
export class WorkflowSubmissionStore {
  private readonly submissions = new Map<string, WorkflowSubmission>();

  /**
   * 保存由记录页面提交、等待对应 Prompt 工具读取的参数。
   * @param toolName 工作流工具的唯一名称。
   * @param values 已提交的表单参数。
   * @param recordId 与表单关联的提示词记录标识。
   * @param projectId 与表单关联的项目标识。
   */
  set(
    toolName: string,
    values: FormValues,
    recordId?: string,
    projectId = '0'
  ): void {
    this.submissions.set(toolName, { values: { ...values }, recordId, projectId });
  }

  /**
   * 读取并移除对应工作流的一次性提交参数。
   * @param toolName 工作流工具的唯一名称。
   * @returns 一次性提交内容及记录标识；不存在时返回 undefined。
   */
  take(toolName: string): WorkflowSubmission | undefined {
    const submission = this.submissions.get(toolName);
    this.submissions.delete(toolName);
    return submission;
  }

  /**
   * Prompt 无法启动时移除尚未消费的提交参数。
   * @param toolName 工作流工具的唯一名称。
   */
  clear(toolName: string): void {
    this.submissions.delete(toolName);
  }
}

export class WorkflowFormTool implements vscode.LanguageModelTool<EmptyToolInput> {
  /**
   * 创建工作流参数工具。
   * @param workflow 工具对应的提示词工作流。
   * @param database 用于保存直接从参数表单提交的数据。
   * @param submissions 用于读取记录页面已提交的数据。
   */
  constructor(
    private readonly workflow: FormWorkflow,
    private readonly database: PromptDatabase,
    private readonly submissions: WorkflowSubmissionStore
  ) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `正在打开${this.workflow.title}参数表单`,
      confirmationMessages: {
        title: `打开${this.workflow.title}参数表单`,
        message: '扩展将显示本地参数表单，并把提交内容返回给当前 Copilot 请求。'
      }
    };
  }

  /**
   * 返回记录页面已提交的参数，或在没有待处理参数时收集新参数。
   * @param _options VS Code 提供的工具调用选项。
   * @param token 当前工具调用的取消令牌。
   * @returns 包含提交参数或取消状态的工具结果。
   */
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const submitted = this.submissions.take(this.workflow.toolName);
    const submission = submitted
      ? {
        values: submitted.values,
        runPrompt: true,
        projectId: submitted.projectId
      }
      : await collectFormValues(
        this.workflow,
        token,
        {},
        this.database.listWorkProjects(),
        listGeneratedContentTasks(this.database)
      );
    const values = submission?.values;
    const imageAttachments = parseImageAttachments(values?.[IMAGE_ATTACHMENTS_FIELD]);
    const parameters: Record<string, string | number> | undefined = values
      ? Object.fromEntries(Object.entries(values).filter(([name]) =>
        name !== IMAGE_ATTACHMENTS_FIELD && name !== 'sourceTaskId' && name !== 'taskName'
      ))
      : undefined;
    if (parameters) {
      for (const field of this.workflow.fields) {
        if (field.inputType === 'number' && typeof parameters[field.name] === 'string') {
          parameters[field.name] = Number(parameters[field.name]);
        }
      }
    }
    if (parameters && values && submission?.runPrompt && this.workflow.toolName === SCREENPLAY_WORKFLOW_NAME) {
      const sourceTask = listGeneratedContentTasks(this.database)
        .find((task) => task.id === values.sourceTaskId && task.projectId === submission.projectId);
      if (!sourceTask) {
        throw new Error('关联创作任务不存在、未生成内容或不属于所选项目。');
      }
      const sourceRecord = this.database.getRecord(sourceTask.id);
      if (!sourceRecord) {
        throw new Error('关联创作任务已不存在。');
      }
      const chapters = this.database.listGeneratedChapterContents(sourceTask.id);
      if (chapters.length === 0) {
        throw new Error('关联创作任务没有可用的章节内容。');
      }
      parameters.sourceMaterial = JSON.stringify(chapters.map(({ chapterNumber, title, content }) => ({
        chapterNumber,
        title,
        content
      })), null, 2);
    }
    let recordId = submitted?.recordId;
    if (values && !submitted) {
      const record = this.database.saveRecord({
        taskName: values.taskName,
        categoryId: this.workflow.toolName,
        categoryName: this.workflow.title,
        projectId: submission.projectId,
        schema: this.workflow.fields,
        data: values
      });
      if (submission.runPrompt) {
        recordId = record.id;
      }
    }

    const result = submission
      ? submission.runPrompt
        ? {
          status: 'submitted',
          workflow: this.workflow.title,
          ...(recordId ? { recordId } : {}),
          parameters
        }
        : {
            status: 'saved',
            workflow: this.workflow.title,
            instruction: '用户选择仅保存参数，不运行生成。停止本次生成。'
          }
      : {
          status: 'cancelled',
          workflow: this.workflow.title,
          instruction: '用户取消了参数表单。停止本次生成，不要自行补全参数。'
        };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
      ...imageAttachments.map((attachment) =>
        vscode.LanguageModelDataPart.image(Buffer.from(attachment.data, 'base64'), attachment.mimeType)
      )
    ]);
  }
}

/** 将 Copilot 生成的最终内容写回对应提示词记录。 */
export class GeneratedResultTool implements vscode.LanguageModelTool<SaveGeneratedResultInput> {
  /**
   * 创建生成结果保存工具。
   * @param database 用于更新提示词记录的数据库。
   */
  constructor(private readonly database: PromptDatabase) {}

  /**
   * 返回保存生成结果时显示的工具调用状态。
   * @returns 工具调用期间显示的状态文本。
   */
  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: '正在保存创作结果' };
  }

  /**
    * 按记录所属工作流保存作品内容或双语提示词。
   * @param options VS Code 提供的工具调用选项。
  * @param _token 当前工具调用的取消令牌。
   * @returns 保存状态与记录标识。
   * @throws 输入缺失或对应记录不存在时抛出错误。
   */
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SaveGeneratedResultInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { recordId, content, chapters, contentZh, contentEn } = options.input;
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new Error('生成结果保存所需的记录标识缺失。');
    }

    const existingRecord = this.database.getRecord(recordId);
    if (!existingRecord) {
      throw new Error('要保存生成结果的提示词记录不存在。');
    }

    let record: ReturnType<PromptDatabase['getRecord']>;
    if (existingRecord.categoryId === SHOOTING_SCRIPT_WORKFLOW_NAME) {
      if (content !== undefined || chapters !== undefined) {
        throw new Error('拍摄脚本必须提交中英文内容，不接受单篇创作内容。');
      }
      if (typeof contentZh !== 'string' || contentZh.trim().length === 0) {
        throw new Error('拍摄脚本中文内容不能为空。');
      }
      if (typeof contentEn !== 'string' || contentEn.trim().length === 0) {
        throw new Error('拍摄脚本英文内容不能为空。');
      }
      record = this.database.replaceGeneratedOutput(recordId, {
        type: 'prompts',
        contentZh,
        contentEn
      });
    } else if (isChapterContentWorkflow(existingRecord.categoryId)) {
      if (content !== undefined || contentZh !== undefined || contentEn !== undefined ||
          !isGeneratedChapterContentArray(chapters)) {
        throw new Error('该工作流必须提交按章拆分的内容。');
      }
      const maxChapters = getConfiguredMaxChapters(existingRecord.data);
      if (chapters.length > maxChapters) {
        throw new Error(`返回章节数不能超过表单设定的 ${maxChapters} 章。`);
      }
      const wordRange = getConfiguredChapterWordRange(existingRecord.data);
      chapters.forEach((chapter) => {
        const wordCount = countChapterWords(chapter.content);
        if (wordCount < wordRange.min || wordCount > wordRange.max) {
          throw new Error(`第 ${chapter.chapterNumber} 章正文统计为 ${wordCount} 字，必须在 ${wordRange.min} 到 ${wordRange.max} 字之间。`);
        }
      });
      record = this.database.replaceGeneratedOutput(recordId, { type: 'chapters', chapters });
    } else if (getWorkflowResultType(existingRecord.categoryId) === 'content') {
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('创作内容不能为空。');
      }
      if (chapters !== undefined || contentZh !== undefined || contentEn !== undefined) {
        throw new Error('该工作流只能提交单篇创作内容。');
      }
      record = this.database.replaceGeneratedOutput(recordId, { type: 'content', content });
    } else {
      if (typeof contentZh !== 'string' || contentZh.trim().length === 0) {
        throw new Error('中文提示词不能为空。');
      }
      if (typeof contentEn !== 'string' || contentEn.trim().length === 0) {
        throw new Error('英文提示词不能为空。');
      }
      if (content !== undefined || chapters !== undefined) {
        throw new Error('该工作流必须提交中英文提示词，不接受单篇创作内容。');
      }
      record = this.database.replaceGeneratedOutput(recordId, {
        type: 'prompts',
        contentZh,
        contentEn
      });
    }

    if (!record) {
      throw new Error('要保存生成结果的提示词记录不存在。');
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify({
        status: 'saved',
        recordId: record.id
      }))
    ]);
  }
}

function isGeneratedChapterContentArray(value: unknown): value is readonly GeneratedChapterContent[] {
  return Array.isArray(value) && value.every((chapter) =>
    typeof chapter === 'object' && chapter !== null && !Array.isArray(chapter) &&
    Object.keys(chapter).length === 3 &&
    'chapterNumber' in chapter && Number.isSafeInteger(chapter.chapterNumber) &&
    'title' in chapter && typeof chapter.title === 'string' &&
    'content' in chapter && typeof chapter.content === 'string'
  );
}

function getConfiguredMaxChapters(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('maxChapters' in value)) {
    throw new Error('记录中缺少章节数上限设置。');
  }
  const configuredValue = value.maxChapters;
  const maxChapters = typeof configuredValue === 'number'
    ? configuredValue
    : typeof configuredValue === 'string' && /^[0-9]+$/.test(configuredValue)
      ? Number(configuredValue)
      : Number.NaN;
  if (!Number.isSafeInteger(maxChapters) || maxChapters < 1 || maxChapters > MAX_GENERATED_CHAPTERS) {
    throw new Error(`章节数上限必须是 1 到 ${MAX_GENERATED_CHAPTERS} 之间的整数。`);
  }
  return maxChapters;
}

function getConfiguredChapterWordRange(value: unknown): { min: number; max: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('chapterMinWords' in value) || !('chapterMaxWords' in value)) {
    throw new Error('记录中缺少每章字数范围设置。');
  }
  const min = typeof value.chapterMinWords === 'number'
    ? value.chapterMinWords
    : typeof value.chapterMinWords === 'string' && /^[0-9]+$/.test(value.chapterMinWords)
      ? Number(value.chapterMinWords)
      : Number.NaN;
  const max = typeof value.chapterMaxWords === 'number'
    ? value.chapterMaxWords
    : typeof value.chapterMaxWords === 'string' && /^[0-9]+$/.test(value.chapterMaxWords)
      ? Number(value.chapterMaxWords)
      : Number.NaN;
  if (!Number.isSafeInteger(min) || min < MIN_CHAPTER_WORDS || min > MAX_CHAPTER_WORDS ||
      !Number.isSafeInteger(max) || max < MIN_CHAPTER_WORDS || max > MAX_CHAPTER_WORDS || min >= max) {
    throw new Error(`每章字数范围必须在 ${MIN_CHAPTER_WORDS} 到 ${MAX_CHAPTER_WORDS} 之间，且上限大于下限。`);
  }
  return { min, max };
}