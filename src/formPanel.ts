import * as vscode from 'vscode';
import { EpisodeNumberRecord, WorkCollection } from './database';
import { FormField, FormValues, FormWorkflow, IMAGE_ATTACHMENTS_FIELD } from './formWorkflows';

const CUSTOM_OPTION_VALUE = '__custom__';
// 限制附件体积，避免表单消息和本地记录因图片过大而膨胀。
const MAX_IMAGE_COUNT = 20;
const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 表示已校验的 PNG 或 JPEG 图片附件。 */
export interface FormImageAttachment {
  readonly mimeType: typeof IMAGE_MIME_TYPES[number];
  readonly data: string;
}

/** 表示表单参数及用户选择的保存行为。 */
export interface FormSubmission {
  readonly values: FormValues;
  readonly runPrompt: boolean;
  /** 表单所选合集；'0' 表示未归属合集。 */
  readonly collectionId: string;
  /** 已选择合集时的正整数集数。 */
  readonly episodeNumber: number | undefined;
}

/** 表单检查合集内集数冲突所需的数据。 */
export interface EpisodeNumberValidationContext {
  readonly records: readonly EpisodeNumberRecord[];
  readonly currentRecordId?: string;
  readonly initialEpisodeNumber?: number;
  readonly findConflict: (
    collectionId: string,
    categoryId: string,
    episodeNumber: number,
    excludeRecordId?: string
  ) => EpisodeNumberRecord | undefined;
}

/**
 * 解析并校验表单中序列化的图片附件。
 * @param value 图片附件的 JSON 字符串；未提供时表示没有图片。
 * @returns 按用户添加顺序排列的图片附件。
 * @throws 图片数据格式、内容签名或大小不符合要求时抛出错误。
 */
export function parseImageAttachments(value: string | undefined): FormImageAttachment[] {
  if (value === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('图片附件数据不是有效的 JSON。');
  }

  if (!Array.isArray(parsed) || parsed.length > MAX_IMAGE_COUNT) {
    throw new Error(`图片数量不能超过 ${MAX_IMAGE_COUNT} 张。`);
  }

  let totalBytes = 0;
  return parsed.map((attachment): FormImageAttachment => {
    if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment) ||
        Object.keys(attachment).length !== 2 ||
        !('mimeType' in attachment) || !IMAGE_MIME_TYPES.includes(attachment.mimeType as typeof IMAGE_MIME_TYPES[number]) ||
        !('data' in attachment) || typeof attachment.data !== 'string' ||
        !BASE64_PATTERN.test(attachment.data)) {
      throw new Error('图片附件必须是有效的 PNG 或 JPEG 图片数据。');
    }

    const imageBytes = Buffer.from(attachment.data, 'base64');
    if (imageBytes.toString('base64') !== attachment.data || imageBytes.byteLength === 0 ||
        imageBytes.byteLength > MAX_IMAGE_FILE_BYTES) {
      throw new Error('图片数据为空、超出单张大小限制或编码无效。');
    }

    const isPng = attachment.mimeType === 'image/png' &&
      imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = attachment.mimeType === 'image/jpeg' &&
      imageBytes[0] === 255 && imageBytes[1] === 216 && imageBytes[2] === 255;
    if (!isPng && !isJpeg) {
      throw new Error('图片内容与声明的 PNG 或 JPEG 格式不匹配。');
    }

    totalBytes += imageBytes.byteLength;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new Error('图片附件总大小不能超过 25 MB。');
    }

    return { mimeType: attachment.mimeType as FormImageAttachment['mimeType'], data: attachment.data };
  });
}

/**
 * 打开工作流参数表单并等待用户提交。
 * @param workflow 当前工作流及其字段定义。
 * @param token 用于在调用取消时关闭表单。
 * @param initialValues 可选的表单初始值。
 * @returns 保存操作及表单参数；取消或关闭表单时返回 undefined。
 */
export function collectFormValues(
  workflow: FormWorkflow,
  token: vscode.CancellationToken,
  episodeContext: EpisodeNumberValidationContext,
  initialValues: FormValues = {},
  collections: readonly WorkCollection[] = []
): Promise<FormSubmission | undefined> {
  if (token.isCancellationRequested) {
    return Promise.resolve(undefined);
  }

  const panel = vscode.window.createWebviewPanel(
    'aiVideoCreation.parameterForm',
    `${workflow.title}参数`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: []
    }
  );

  panel.webview.html = createFormHtml(workflow, initialValues, collections, episodeContext);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];

    const finish = (submission: FormSubmission | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      panel.dispose();
      resolve(submission);
    };

    subscriptions.push(panel.onDidDispose(() => finish(undefined)));
    subscriptions.push(token.onCancellationRequested(() => finish(undefined)));
    subscriptions.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRecord(message)) {
        return;
      }

      if (message.command === 'cancel') {
        finish(undefined);
        return;
      }

      if (message.command !== 'save' && message.command !== 'submit') {
        return;
      }

      const values = readFormValues(message.values, workflow);
      const collectionId = message.collectionId;
      if (!values || typeof collectionId !== 'string' ||
          (collectionId !== '0' && !collections.some((collection) => collection.id === collectionId))) {
        void panel.webview.postMessage({
          command: 'validation-error',
          text: '表单数据无效，请检查后重新提交。'
        });
        return;
      }

      const requiresEpisodeNumber = workflow.supportsEpisodeNumber !== false && collectionId !== '0';
      const episodeNumberValue = message.episodeNumber;
      let episodeNumber: number | undefined;
      if (episodeNumberValue !== undefined && episodeNumberValue !== '') {
        if (typeof episodeNumberValue !== 'string' || !/^[0-9]+$/.test(episodeNumberValue)) {
          void panel.webview.postMessage({
            command: 'validation-error',
            text: '“当前集数”必须填写大于或等于 1 的整数。'
          });
          return;
        }
        episodeNumber = Number(episodeNumberValue);
        if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
          void panel.webview.postMessage({
            command: 'validation-error',
            text: '“当前集数”必须填写大于或等于 1 的整数。'
          });
          return;
        }
      }
      if (requiresEpisodeNumber && episodeNumber === undefined) {
        const collectionName = collections.find((collection) => collection.id === collectionId)?.name;
        void panel.webview.postMessage({
          command: 'validation-error',
          text: `已选择合集“${collectionName}”，必须填写“当前集数”，且只能填写大于或等于 1 的整数。`
        });
        return;
      }
      if (!requiresEpisodeNumber && episodeNumber !== undefined) {
        void panel.webview.postMessage({
          command: 'validation-error',
          text: '当前任务或未归属合集不能设置集数，请检查合集选择。'
        });
        return;
      }
      if (episodeNumber !== undefined) {
        const conflict = episodeContext.findConflict(
          collectionId,
          workflow.toolName,
          episodeNumber,
          episodeContext.currentRecordId
        );
        if (conflict) {
          void panel.webview.postMessage({
            command: 'validation-error',
            text: formatEpisodeNumberConflict(conflict)
          });
          return;
        }
      }

      if (message.command === 'submit' && workflow.supportsImageAttachments &&
          parseImageAttachments(values[IMAGE_ATTACHMENTS_FIELD]).length === 0) {
        void panel.webview.postMessage({
          command: 'validation-error',
          text: '图片灵感写作至少需要添加一张图片。'
        });
        return;
      }

      finish({ values, runPrompt: message.command === 'submit', collectionId, episodeNumber });
    }));
  });
}

/** 校验工作流表单字段和工作流专用的附件数据。 */
function readFormValues(value: unknown, workflow: FormWorkflow): FormValues | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const fields = workflow.fields;
  const expectedNames = fields.map((field) => field.name);
  if (workflow.supportsImageAttachments) {
    expectedNames.push(IMAGE_ATTACHMENTS_FIELD);
  }
  const invalidNumberField = workflow.fields.some((field) => {
    if (field.inputType !== 'number') {
      return false;
    }
    const rawValue = value[field.name];
    if (typeof rawValue !== 'string' || !/^[0-9]+$/.test(rawValue)) {
      return true;
    }
    const numericValue = Number(rawValue);
    return !Number.isSafeInteger(numericValue) ||
      (field.min !== undefined && numericValue < field.min) ||
      (field.max !== undefined && numericValue > field.max);
  });
  const actualNames = Object.keys(value);
  if (actualNames.length !== expectedNames.length ||
      expectedNames.some((name) => typeof value[name] !== 'string') ||
      actualNames.some((name) => !expectedNames.includes(name)) ||
      fields.some((field) => field.required && !(value[field.name] as string).trim()) ||
      invalidNumberField ||
      fields.some((field) => field.options && !field.allowCustom && value[field.name] !== '' && !field.options.includes(value[field.name] as string)) ||
      fields.some((field) => field.allowCustom && value[field.name] === CUSTOM_OPTION_VALUE)) {
    return undefined;
  }

  if (workflow.supportsImageAttachments) {
    try {
      parseImageAttachments(value[IMAGE_ATTACHMENTS_FIELD] as string);
    } catch {
      return undefined;
    }
  }

  return Object.fromEntries(expectedNames.map((name) => [name, value[name] as string]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 生成带有工作流字段和操作按钮的表单页面。 */
function createFormHtml(
  workflow: FormWorkflow,
  initialValues: FormValues,
  collections: readonly WorkCollection[],
  episodeContext: EpisodeNumberValidationContext
): string {
  const nonce = createNonce();
  const imageAttachments = workflow.supportsImageAttachments
    ? parseImageAttachments(initialValues[IMAGE_ATTACHMENTS_FIELD])
    : [];
  const imageAttachmentField = workflow.supportsImageAttachments
    ? `<section class="image-attachment-area" id="image-attachment-area" data-initial-images="${escapeHtml(JSON.stringify(imageAttachments))}" aria-label="图片附件">
        <h2 class="attachment-title">图片附件</h2>
        <div class="image-grid" id="image-grid"></div>
        <input class="image-file-input" id="image-file-input" type="file" accept="image/png,image/jpeg" multiple>
        <p class="image-status" id="image-status" role="status" aria-live="polite"></p>
      </section>`
    : '';
  const fields = workflow.fields.map((field) =>
    renderField(field, initialValues[field.name] ?? '')
  ).join('');
  const collectionField = renderWorkCollectionField(collections, initialValues.collectionId ?? '0');
  const episodeNumberField = renderEpisodeNumberField(
    workflow.supportsEpisodeNumber !== false,
    initialValues.collectionId ?? '0',
    episodeContext.initialEpisodeNumber
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(workflow.title)}参数</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; }
    main { max-width: 1080px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
    .notice { margin: 0 0 22px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
    form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
    .image-attachment-area {
      min-width: 0; padding: 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
    }
    .attachment-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
    .image-grid { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px; }
    .image-card, .image-add {
      position: relative; width: 88px; height: 88px; flex: 0 0 88px; overflow: hidden;
      border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    }
    .image-card img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .image-remove {
      position: absolute; top: 3px; right: 3px; min-width: 24px; min-height: 24px;
      padding: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      font-size: 18px; line-height: 1;
    }
    .image-add {
      display: grid; place-items: center; padding: 0; color: var(--vscode-descriptionForeground);
      background: var(--vscode-input-background); border-style: dashed;
    }
    .image-add:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .image-add-symbol { font-size: 36px; font-weight: 300; line-height: 1; }
    .image-file-input { display: none; }
    .image-status { min-height: 0; margin: 6px 0 0; color: var(--vscode-errorForeground); font-size: 12px; }
    .image-status:empty { display: none; }
    .field { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
    .field[hidden] { display: none; }
    .field-heading { display: flex; min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
    label { font-size: 13px; font-weight: 600; }
    .field-label { font-size: 13px; font-weight: 600; }
    .field-description { color: var(--vscode-foreground); opacity: .82; font-size: 12px; }
    .episode-number-error { min-height: 18px; margin: 0; color: var(--vscode-errorForeground); font-size: 12px; }
    .episode-number-error:empty { display: none; }
    textarea, select {
      width: 100%; resize: none; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    #episode-number {
      width: 100%; min-height: 38px; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    #episode-number:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    input[type="number"] {
      width: 100%; min-height: 38px; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    input[type="number"]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    textarea { max-height: calc(17.4em + 20px); overflow-y: auto; }
    select { min-height: 38px; resize: none; }
    .collection-picker { position: relative; width: 100%; }
    .collection-picker-trigger {
      display: flex; width: 100%; min-height: 38px; align-items: center; justify-content: space-between;
      gap: 12px; padding: 9px 10px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45; text-align: left;
    }
    .collection-picker-trigger.is-scope-option { color: var(--vscode-textLink-foreground); }
    .collection-picker-trigger:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .collection-picker-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .collection-picker-chevron {
      width: 8px; height: 8px; flex: 0 0 auto; margin: -4px 2px 0 0;
      border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg);
    }
    .collection-picker-menu {
      position: absolute; z-index: 5; top: calc(100% + 2px); right: 0; left: 0;
      max-height: min(240px, 50vh); overflow-y: auto; padding: 3px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 3px; box-shadow: 0 3px 8px var(--vscode-widget-shadow);
    }
    .collection-picker-menu[hidden] { display: none; }
    .collection-picker-option {
      display: block; width: 100%; min-height: 32px; padding: 5px 9px; overflow: hidden;
      color: var(--vscode-input-foreground); background: transparent; border: 0;
      font: inherit; line-height: 1.45; text-align: left; text-overflow: ellipsis; white-space: nowrap;
    }
    .collection-picker-option.is-scope-option { color: var(--vscode-textLink-foreground); }
    .collection-picker-option:hover,
    .collection-picker-option:focus-visible {
      background: var(--vscode-list-hoverBackground);
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 90%, #FFFFFF);
      outline: none;
    }
    .collection-picker-option[aria-selected="true"] {
      color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-input-foreground));
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .collection-picker-option.is-scope-option[aria-selected="true"] { color: var(--vscode-textLink-foreground); }
    .select-with-custom { display: flex; width: 100%; min-width: 0; gap: 8px; }
    .select-with-custom select { flex: 1 1 100%; min-width: 0; }
    .select-with-custom.has-custom select { flex: 0 1 auto; max-width: 55%; }
    .custom-option {
      flex: 1 1 0; min-width: 0; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    .custom-option[hidden] { display: none; }
    textarea:focus, select:focus, .custom-option:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 24px; padding-top: 4px; }
    .secondary-actions { display: flex; align-items: center; gap: 8px; }
    button { min-height: 30px; padding: 5px 13px; border: 0; border-radius: 3px; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { opacity: .65; cursor: wait; }
    .secondary { color: #273746; background: #E8EDF2; }
    .secondary:hover { background: #DDE4EA; }
    .secondary-actions #save { color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
    .secondary-actions #save:hover { background: var(--vscode-button-hoverBackground); }
    .primary { color: #18374A; background: #D7EAF5; }
    .primary:hover { background: #C8E0EE; }
    #status { min-height: 20px; color: var(--vscode-errorForeground); }
    @media (max-width: 680px) {
      body { padding: 18px; }
      form { gap: 15px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(workflow.title)}</h1>
    <p class="notice">${escapeHtml(workflow.notice)}选择“保存并运行”后，Copilot 将使用表单内容继续执行。</p>
    <form id="parameter-form">
      ${collectionField}
      ${episodeNumberField}
      ${imageAttachmentField}
      ${fields}
      <div id="status" role="status" aria-live="polite"></div>
      <div class="actions">
        <div class="secondary-actions">
          <button class="secondary" id="cancel" type="button">取消</button>
          <button class="secondary" id="save" type="button">保存</button>
        </div>
        <button class="primary" id="submit" type="submit">保存并运行</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('parameter-form');
    const saveButton = document.getElementById('save');
    const submitButton = document.getElementById('submit');
    const status = document.getElementById('status');
    const imageAttachmentArea = document.getElementById('image-attachment-area');
    const collectionSelect = document.getElementById('collectionId');
    const collectionPicker = document.getElementById('collection-picker');
    const collectionPickerTrigger = document.getElementById('collection-picker-trigger');
    const collectionPickerLabel = document.getElementById('collection-picker-label');
    const collectionPickerMenu = document.getElementById('collection-picker-menu');
    const collectionPickerOptions = Array.from(collectionPickerMenu.querySelectorAll('[role="option"]'));
    const supportsEpisodeNumber = ${workflow.supportsEpisodeNumber !== false};
    const episodeNumberField = document.getElementById('episode-number-field');
    const episodeNumberInput = document.getElementById('episode-number');
    const episodeNumberError = document.getElementById('episode-number-error');
    const episodeNumberRecords = ${serializeForScript(episodeContext.records)};
    const currentRecordId = ${serializeForScript(episodeContext.currentRecordId ?? '')};
    const workflowCategoryId = ${serializeForScript(workflow.toolName)};

    // 按当前合集、任务类型、集数和编辑记录标识查找本地冲突。
    function findLocalEpisodeConflict(collectionId, rawEpisodeNumber) {
      if (!supportsEpisodeNumber || collectionId === '0' || !/^[0-9]+$/.test(rawEpisodeNumber)) {
        return undefined;
      }
      const episodeNumber = Number(rawEpisodeNumber);
      if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
        return undefined;
      }
      return episodeNumberRecords.find((record) =>
        record.collectionId === collectionId && record.categoryId === workflowCategoryId &&
        record.episodeNumber === episodeNumber &&
        record.id !== currentRecordId
      );
    }

    // 将冲突记录转换为用户可直接处理的提示。
    function formatLocalEpisodeConflict(record) {
      return '合集“' + record.collectionName + '”的第 ' + record.episodeNumber +
        ' 集已被同类任务“' + (record.title || '未命名任务') + '”（' + record.categoryName +
        '）占用。请更改集数或选择其他合集。';
    }

    // 显示或隐藏集数字段，并同步集数输入框的原生校验状态。
    function updateEpisodeNumberField() {
      if (!supportsEpisodeNumber) return;
      const isRequired = collectionSelect.value !== '0';
      episodeNumberField.hidden = !isRequired;
      episodeNumberInput.disabled = !isRequired;
      episodeNumberInput.required = isRequired;
      if (!isRequired) {
        episodeNumberInput.value = '';
        episodeNumberError.textContent = '';
        episodeNumberInput.setCustomValidity('');
        return;
      }

      const rawEpisodeNumber = episodeNumberInput.value;
      let validationMessage;
      if (!/^[0-9]+$/.test(rawEpisodeNumber) || !Number.isSafeInteger(Number(rawEpisodeNumber)) || Number(rawEpisodeNumber) < 1) {
        validationMessage = '已选择合集，必须填写“当前集数”，且只能填写大于或等于 1 的整数。';
      } else {
        const conflict = findLocalEpisodeConflict(collectionSelect.value, rawEpisodeNumber);
        if (conflict) validationMessage = formatLocalEpisodeConflict(conflict);
      }
      episodeNumberError.textContent = validationMessage ?? '';
      episodeNumberInput.setCustomValidity(validationMessage ?? '');
    }

    function closeCollectionPicker(returnFocus = false) {
      collectionPickerMenu.hidden = true;
      collectionPickerTrigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) collectionPickerTrigger.focus();
    }

    function openCollectionPicker(focusIndex) {
      collectionPickerMenu.hidden = false;
      collectionPickerTrigger.setAttribute('aria-expanded', 'true');
      const selectedIndex = collectionPickerOptions.findIndex((option) => option.getAttribute('aria-selected') === 'true');
      collectionPickerOptions[Math.max(0, Math.min(focusIndex ?? selectedIndex, collectionPickerOptions.length - 1))]?.focus();
    }

    collectionPickerTrigger.addEventListener('click', () => {
      if (collectionPickerMenu.hidden) openCollectionPicker();
      else closeCollectionPicker();
    });
    collectionPickerTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openCollectionPicker();
      }
    });
    collectionPickerOptions.forEach((option, index) => {
      option.addEventListener('click', () => {
        const conflict = supportsEpisodeNumber
          ? findLocalEpisodeConflict(option.dataset.value, episodeNumberInput.value)
          : undefined;
        if (conflict) {
          episodeNumberError.textContent = formatLocalEpisodeConflict(conflict);
          return;
        }
        collectionSelect.value = option.dataset.value;
        collectionPickerLabel.textContent = option.textContent;
        collectionPickerTrigger.classList.toggle('is-scope-option', option.classList.contains('is-scope-option'));
        collectionPickerOptions.forEach((candidate) => {
          candidate.setAttribute('aria-selected', String(candidate === option));
        });
        collectionSelect.dispatchEvent(new Event('change', { bubbles: true }));
        updateEpisodeNumberField();
        closeCollectionPicker(true);
      });
      option.addEventListener('keydown', (event) => {
        let nextIndex;
        if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, collectionPickerOptions.length - 1);
        else if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = collectionPickerOptions.length - 1;
        else if (event.key === 'Escape') {
          event.preventDefault();
          closeCollectionPicker(true);
          return;
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          option.click();
          return;
        } else return;
        event.preventDefault();
        collectionPickerOptions[nextIndex].focus();
      });
    });
    collectionPicker.addEventListener('focusout', (event) => {
      if (!collectionPicker.contains(event.relatedTarget)) closeCollectionPicker();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!collectionPicker.contains(event.target)) closeCollectionPicker();
    });
    if (supportsEpisodeNumber) {
      episodeNumberInput.addEventListener('input', updateEpisodeNumberField);
      updateEpisodeNumberField();
    }

    let imageAttachments = imageAttachmentArea
      ? JSON.parse(imageAttachmentArea.dataset.initialImages)
      : [];

    // 绘制缩略图，并将添加入口保持在图片列表末尾。
    function renderImageAttachments() {
      if (!imageAttachmentArea) {
        return;
      }

      const imageGrid = document.getElementById('image-grid');
      const fileInput = document.getElementById('image-file-input');
      imageGrid.replaceChildren();
      imageAttachments.forEach((attachment, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';
        const image = document.createElement('img');
        image.src = 'data:' + attachment.mimeType + ';base64,' + attachment.data;
        image.alt = '图片 ' + (index + 1);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'image-remove';
        remove.textContent = '×';
        remove.title = '移除图片';
        remove.setAttribute('aria-label', '移除第 ' + (index + 1) + ' 张图片');
        remove.addEventListener('click', () => {
          imageAttachments.splice(index, 1);
          renderImageAttachments();
        });
        card.append(image, remove);
        imageGrid.append(card);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'image-add';
      add.title = '添加图片';
      add.setAttribute('aria-label', '添加图片');
      const plus = document.createElement('span');
      plus.className = 'image-add-symbol';
      plus.textContent = '+';
      add.append(plus);
      add.addEventListener('click', () => fileInput.click());
      imageGrid.append(add);
    }

    // 将上传或粘贴的文件读取为可传递的图片数据。
    function readImageFile(file) {
      return new Promise((resolve, reject) => {
        if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
          reject(new Error('仅支持 PNG 和 JPEG 图片。'));
          return;
        }
        if (file.size > ${MAX_IMAGE_FILE_BYTES}) {
          reject(new Error('单张图片不能超过 10 MB。'));
          return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            reject(new Error('读取图片失败，请重新选择。'));
            return;
          }
          const dataUrl = /^data:(image\\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(reader.result);
          if (!dataUrl) {
            reject(new Error('图片内容不是有效的 PNG 或 JPEG 数据。'));
            return;
          }
          resolve({ mimeType: dataUrl[1], data: dataUrl[2] });
        };
        reader.readAsDataURL(file);
      });
    }

    // 校验并静默去重后，将新图片追加到当前列表。
    async function addImageFiles(fileList) {
      const files = Array.from(fileList);
      if (files.length === 0) {
        return;
      }

      const imageStatus = document.getElementById('image-status');
      try {
        const addedImages = await Promise.all(files.map(readImageFile));
        const knownImageData = new Set(imageAttachments.map((attachment) => attachment.data));
        const uniqueImages = addedImages.filter((attachment) => {
          if (knownImageData.has(attachment.data)) {
            return false;
          }
          knownImageData.add(attachment.data);
          return true;
        });
        if (uniqueImages.length === 0) {
          return;
        }

        if (imageAttachments.length + uniqueImages.length > ${MAX_IMAGE_COUNT}) {
          imageStatus.textContent = '图片最多添加 ${MAX_IMAGE_COUNT} 张。';
          return;
        }

        const totalBytes = [...imageAttachments, ...uniqueImages]
          .reduce((total, attachment) => total + Math.ceil(attachment.data.length * 3 / 4), 0);
        if (totalBytes > ${MAX_IMAGE_TOTAL_BYTES}) {
          throw new Error('图片附件总大小不能超过 25 MB。');
        }
        imageAttachments.push(...uniqueImages);
        imageStatus.textContent = '';
        renderImageAttachments();
      } catch (error) {
        imageStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    if (imageAttachmentArea) {
      const fileInput = document.getElementById('image-file-input');
      fileInput.addEventListener('change', () => {
        void addImageFiles(fileInput.files);
        fileInput.value = '';
      });
      window.addEventListener('paste', (event) => {
        if (!imageAttachmentArea.matches(':hover') && !imageAttachmentArea.contains(document.activeElement)) {
          return;
        }

        const pastedImages = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter((file) => file !== null);
        if (pastedImages.length > 0) {
          event.preventDefault();
          void addImageFiles(pastedImages);
        }
      });
      renderImageAttachments();
    }

    // 表单文本框随内容增高，避免手动拖动尺寸。
    document.querySelectorAll('textarea').forEach((textarea) => {
      const resizeTextarea = () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      };
      textarea.addEventListener('input', resizeTextarea);
      resizeTextarea();
    });

    function sendFormValues(runPrompt) {
      updateEpisodeNumberField();
      if (!form.reportValidity()) {
        return;
      }
      const formData = new FormData(form);
      const values = Object.fromEntries(
        [...formData.entries()].filter(([name]) => name !== 'collectionId' && !name.endsWith('__custom'))
      );
      const collectionId = formData.get('collectionId');
      document.querySelectorAll('[data-custom-input]').forEach((select) => {
        if (select.value === '${CUSTOM_OPTION_VALUE}') {
          const customInput = document.getElementById(select.dataset.customInput);
          values[select.name] = customInput.value;
        }
      });
      if (imageAttachmentArea) {
        values['${IMAGE_ATTACHMENTS_FIELD}'] = JSON.stringify(imageAttachments);
      }
      saveButton.disabled = true;
      submitButton.disabled = true;
      status.textContent = '';
      vscode.postMessage({
        command: runPrompt ? 'submit' : 'save',
        values,
        collectionId,
        episodeNumber: supportsEpisodeNumber ? episodeNumberInput.value : undefined
      });
    }

    document.querySelectorAll('[data-custom-input]').forEach((select) => {
      const customInput = document.getElementById(select.dataset.customInput);
      const wrapper = select.closest('.select-with-custom');
      const updateCustomInput = () => {
        const isCustom = select.value === '${CUSTOM_OPTION_VALUE}';
        customInput.hidden = !isCustom;
        customInput.disabled = !isCustom;
        customInput.required = isCustom;
        wrapper.classList.toggle('has-custom', isCustom);
        if (isCustom) {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (context) {
            context.font = getComputedStyle(select).font;
            const textWidth = context.measureText(select.selectedOptions[0].textContent).width;
            select.style.width = \`\${Math.ceil(textWidth + 42)}px\`;
          }
        } else {
          select.style.width = '';
        }
      };

      select.addEventListener('change', updateCustomInput);
      updateCustomInput();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      sendFormValues(true);
    });

    saveButton.addEventListener('click', () => sendFormValues(false));

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    window.addEventListener('message', (event) => {
      if (event.data.command === 'validation-error') {
        saveButton.disabled = false;
        submitButton.disabled = false;
        status.textContent = event.data.text;
        if (supportsEpisodeNumber && collectionSelect.value !== '0') {
          updateEpisodeNumberField();
        }
      }
    });
  </script>
</body>
</html>`;
}

/** 生成固定在任务参数表单顶部的合集归属选择项。 */
function renderWorkCollectionField(collections: readonly WorkCollection[], selectedWorkCollectionId: string): string {
  const options = [
    { id: '0', name: '未归属合集', isScopeOption: true },
    ...collections.map((collection) => ({ id: collection.id, name: collection.name, isScopeOption: false }))
  ];
  const nativeOptions = options.map((option) =>
    `<option value="${escapeHtml(option.id)}"${option.id === selectedWorkCollectionId ? ' selected' : ''}>${escapeHtml(option.name)}</option>`
  ).join('');
  const pickerOptions = options.map((option) => {
    const isSelected = option.id === selectedWorkCollectionId;
    const classes = ['collection-picker-option'];
    if (option.isScopeOption) classes.push('is-scope-option');
    return `<button class="${classes.join(' ')}" type="button" role="option" data-value="${escapeHtml(option.id)}" aria-selected="${isSelected}">${escapeHtml(option.name)}</button>`;
  }).join('');
  const selectedOption = options.find((option) => option.id === selectedWorkCollectionId) ?? options[0];
  return `<div class="field">
    <div class="field-heading"><span class="field-label" id="collectionId-label">所属合集</span></div>
    <div class="collection-picker" id="collection-picker">
      <select id="collectionId" name="collectionId" hidden aria-hidden="true" tabindex="-1">${nativeOptions}</select>
      <button class="collection-picker-trigger${selectedOption.isScopeOption ? ' is-scope-option' : ''}" id="collection-picker-trigger" type="button" aria-labelledby="collectionId-label collection-picker-label" aria-haspopup="listbox" aria-controls="collection-picker-menu" aria-expanded="false">
        <span class="collection-picker-label" id="collection-picker-label">${escapeHtml(selectedOption.name)}</span>
        <span class="collection-picker-chevron" aria-hidden="true"></span>
      </button>
      <div class="collection-picker-menu" id="collection-picker-menu" role="listbox" aria-labelledby="collectionId-label" hidden>${pickerOptions}</div>
    </div>
  </div>`;
}

/** 生成仅在任务绑定合集时显示的必填集数字段。 */
function renderEpisodeNumberField(
  supportsEpisodeNumber: boolean,
  selectedCollectionId: string,
  initialEpisodeNumber: number | undefined
): string {
  if (!supportsEpisodeNumber) {
    return '';
  }
  const isRequired = selectedCollectionId !== '0';
  const value = initialEpisodeNumber === undefined ? '' : String(initialEpisodeNumber);
  return `<div class="field" id="episode-number-field"${isRequired ? '' : ' hidden'}>
    <div class="field-heading"><label for="episode-number">当前集数</label></div>
    <input id="episode-number" type="number" min="1" step="1" inputmode="numeric" placeholder="输入正整数" value="${escapeHtml(value)}"${isRequired ? ' required' : ' disabled'} aria-describedby="episode-number-error">
    <p class="episode-number-error" id="episode-number-error" role="status" aria-live="polite"></p>
  </div>`;
}

/** 生成包含合集、集数和占用任务信息的冲突说明。 */
function formatEpisodeNumberConflict(conflict: EpisodeNumberRecord): string {
  return `合集“${conflict.collectionName}”的第 ${conflict.episodeNumber} 集已被任务“${conflict.title ?? '未命名任务'}”（${conflict.categoryName}）占用。请更改集数或选择其他合集。`;
}

/** 转义内嵌脚本数据，避免用户文本结束脚本标签。 */
function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderField(field: FormField, initialValue: string): string {
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label);
  const description = escapeHtml(field.description);
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const required = field.required ? ' required' : '';
  const numericAttributes = field.inputType === 'number'
    ? ` type="number" step="1" inputmode="numeric"${field.min === undefined ? '' : ` min="${field.min}"`}${field.max === undefined ? '' : ` max="${field.max}"`}`
    : '';
  const control = field.options
    ? `<div class="select-with-custom">
        <select id="${name}" name="${name}"${required}${field.allowCustom ? ` data-custom-input="${name}-custom"` : ''}>
          <option value=""${initialValue === '' ? ' selected' : ''}>请选择</option>
          ${field.options.map((option) => `<option value="${escapeHtml(option)}"${initialValue === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          ${field.allowCustom ? `<option value="${CUSTOM_OPTION_VALUE}"${initialValue !== '' && !field.options?.includes(initialValue) ? ' selected' : ''}>其他</option>` : ''}
        </select>
        ${field.allowCustom ? `<input class="custom-option" id="${name}-custom" name="${name}__custom" type="text" placeholder="输入自定义内容" value="${initialValue !== '' && !field.options.includes(initialValue) ? escapeHtml(initialValue) : ''}" disabled hidden>` : ''}
      </div>`
    : field.inputType === 'number'
      ? `<input id="${name}" name="${name}"${numericAttributes}${placeholder}${required} value="${escapeHtml(initialValue)}">`
      : `<textarea id="${name}" name="${name}"${placeholder}${required} rows="1" spellcheck="true">${escapeHtml(initialValue)}</textarea>`;

  return `<div class="field">
        <div class="field-heading">
          <label for="${name}">${label}</label>
          <span class="field-description">${description}</span>
        </div>
        ${control}
      </div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };

    return entities[character];
  });
}

function createNonce(): string {
  const values = new Uint8Array(24);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}