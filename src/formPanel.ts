import * as vscode from 'vscode';
import { FormField, FormValues, FormWorkflow } from './formWorkflows';

const CUSTOM_OPTION_VALUE = '__custom__';

export function collectFormValues(
  workflow: FormWorkflow,
  token: vscode.CancellationToken,
  initialValues: FormValues = {}
): Promise<FormValues | undefined> {
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

  panel.webview.html = createFormHtml(panel.webview, workflow, initialValues);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];

    const finish = (values: FormValues | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      panel.dispose();
      resolve(values);
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

      if (message.command !== 'submit') {
        return;
      }

      const values = readFormValues(message.values, workflow.fields);
      if (!values) {
        void panel.webview.postMessage({
          command: 'validation-error',
          text: '表单数据无效，请检查后重新提交。'
        });
        return;
      }

      finish(values);
    }));
  });
}

function readFormValues(value: unknown, fields: readonly FormField[]): FormValues | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const expectedNames = fields.map((field) => field.name);
  const actualNames = Object.keys(value);
  if (actualNames.length !== expectedNames.length ||
      expectedNames.some((name) => typeof value[name] !== 'string') ||
      actualNames.some((name) => !expectedNames.includes(name)) ||
      fields.some((field) => field.required && !(value[field.name] as string).trim()) ||
      fields.some((field) => field.options && !field.allowCustom && value[field.name] !== '' && !field.options.includes(value[field.name] as string)) ||
      fields.some((field) => field.allowCustom && value[field.name] === CUSTOM_OPTION_VALUE)) {
    return undefined;
  }

  return Object.fromEntries(expectedNames.map((name) => [name, value[name] as string]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createFormHtml(
  webview: vscode.Webview,
  workflow: FormWorkflow,
  initialValues: FormValues
): string {
  const nonce = createNonce();
  const fields = workflow.fields.map((field) =>
    renderField(field, initialValues[field.name] ?? '')
  ).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
    .field { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
    .field-heading { display: flex; min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
    label { font-size: 13px; font-weight: 600; }
    .field-description { color: var(--vscode-foreground); opacity: .82; font-size: 12px; }
    textarea, select {
      width: 100%; resize: vertical; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    select { min-height: 38px; resize: none; }
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
    .actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
    button { min-height: 30px; padding: 5px 13px; border: 0; border-radius: 3px; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { opacity: .65; cursor: wait; }
    .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
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
    <p class="notice">${escapeHtml(workflow.notice)}提交后，Copilot 将使用表单内容继续执行。</p>
    <form id="parameter-form">
      ${fields}
      <div id="status" role="status" aria-live="polite"></div>
      <div class="actions">
        <button class="secondary" id="cancel" type="button">取消</button>
        <button class="primary" id="submit" type="submit">提交</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('parameter-form');
    const submitButton = document.getElementById('submit');
    const status = document.getElementById('status');

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
      const formData = new FormData(form);
      const values = Object.fromEntries(
        [...formData.entries()].filter(([name]) => !name.endsWith('__custom'))
      );
      document.querySelectorAll('[data-custom-input]').forEach((select) => {
        if (select.value === '${CUSTOM_OPTION_VALUE}') {
          const customInput = document.getElementById(select.dataset.customInput);
          values[select.name] = customInput.value;
        }
      });
      submitButton.disabled = true;
      status.textContent = '';
      vscode.postMessage({ command: 'submit', values });
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    window.addEventListener('message', (event) => {
      if (event.data.command === 'validation-error') {
        submitButton.disabled = false;
        status.textContent = event.data.text;
      }
    });
  </script>
</body>
</html>`;
}

function renderField(field: FormField, initialValue: string): string {
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label);
  const description = escapeHtml(field.description);
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const required = field.required ? ' required' : '';
  const control = field.options
    ? `<div class="select-with-custom">
        <select id="${name}" name="${name}"${required}${field.allowCustom ? ` data-custom-input="${name}-custom"` : ''}>
          <option value=""${initialValue === '' ? ' selected' : ''}>请选择</option>
          ${field.options.map((option) => `<option value="${escapeHtml(option)}"${initialValue === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          ${field.allowCustom ? `<option value="${CUSTOM_OPTION_VALUE}"${initialValue !== '' && !field.options?.includes(initialValue) ? ' selected' : ''}>其他</option>` : ''}
        </select>
        ${field.allowCustom ? `<input class="custom-option" id="${name}-custom" name="${name}__custom" type="text" placeholder="输入自定义内容" value="${initialValue !== '' && !field.options.includes(initialValue) ? escapeHtml(initialValue) : ''}" disabled hidden>` : ''}
      </div>`
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