import { MAX_GENERATED_CHAPTERS, MAX_CHAPTER_WORDS, MIN_CHAPTER_WORDS } from './chapterContent';

export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly inputType?: 'number';
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  readonly allowCustom?: boolean;
  /** 是否将自定义输入框放在下拉框下方。 */
  readonly customInputBelow?: boolean;
  readonly projectContentTask?: boolean;
  /** 关联任务必须属于指定工作流。 */
  readonly projectTaskCategory?: string;
  readonly required?: boolean;
}

export interface FormWorkflow {
  readonly toolName: string;
  readonly title: string;
  readonly promptPath: string;
  readonly resultType: WorkflowResultType;
  readonly notice: string;
  readonly fields: readonly FormField[];
  /** 是否要求参数表单必须归属一个项目。 */
  readonly requiresProject?: boolean;
  /** 是否在参数表单中显示“保存并运行”按钮。 */
  readonly showRunButton?: boolean;
  /** 参数表单是否接受用户附加图片。 */
  readonly supportsImageAttachments?: boolean;
  /** 是否以独立章节内容返回生成结果。 */
  readonly supportsChapterContent?: boolean;
}

export type WorkflowResultType = 'content' | 'prompt';

export type FormValues = Record<string, string>;

/** 表单与工作流工具之间传递图片附件的隐藏字段名。 */
export const IMAGE_ATTACHMENTS_FIELD = '__imageAttachments';
export const CREATIVE_WRITING_WORKFLOW_NAME = 'ai-video-creation-tools_collect_creative_writing_parameters';
export const IMAGE_INSPIRED_WRITING_WORKFLOW_NAME = 'ai-video-creation-tools_collect_image_inspired_writing_parameters';
export const NOVEL_RECREATION_WORKFLOW_NAME = 'ai-video-creation-tools_collect_novel_parameters';
export const UNIQUE_CONTENT_TASK_WORKFLOW_NAMES = [
  CREATIVE_WRITING_WORKFLOW_NAME,
  IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
  NOVEL_RECREATION_WORKFLOW_NAME
] as const;
export const SCREENPLAY_WORKFLOW_NAME = 'ai-video-creation-tools_collect_screenplay_parameters';
export const SHOOTING_SCRIPT_WORKFLOW_NAME = 'ai-video-creation-tools_collect_shooting_script_parameters';

export const TASK_NAME_FIELD: FormField = {
  name: 'taskName',
  label: '任务名称',
  description: '必填，用于在任务列表中识别这项任务',
  placeholder: '输入任务名称',
  required: true
};

const VISUAL_STYLE_OPTIONS = [
  '写实电影风格',
  '写实摄影',
  '2D动漫插画',
  '3D动画风格',
  '游戏概念设计',
  '水彩插画',
  '黑白线稿'
] as const;

const SCENE_STYLE_OPTIONS = [
  '写实电影风格',
  '写实摄影',
  '建筑可视化',
  '3D场景渲染',
  '游戏概念设计',
  '2D动漫背景',
  '水彩插画'
] as const;

const EFFECT_STYLE_OPTIONS = [
  '写实电影特效',
  '科幻能量特效',
  '魔法粒子特效',
  '烟雾与火焰特效',
  '2D动漫特效',
  '3D特效渲染',
  '游戏特效概念设计'
] as const;

const GENRE_OPTIONS = ['悬疑', '爱情', '科幻', '奇幻', '喜剧', '现实题材', '历史', '武侠', '冒险', '恐怖'] as const;

const CHARACTER_COMPOSITION_OPTIONS = [
  '正面全身像',
  '三视图（正面、侧面、背面）',
  '正面半身像',
  '侧面全身像',
  '面部特写'
] as const;

const SCENE_COMPOSITION_OPTIONS = [
  '平视广角全景',
  '入口方向全景',
  '俯视布局图',
  '轴测空间图',
  '局部区域特写'
] as const;

const PROP_COMPOSITION_OPTIONS = [
  '单体居中展示',
  '三视图（正面、侧面、背面）',
  '正面图',
  '45度产品视角',
  '细节特写'
] as const;

const EFFECT_COMPOSITION_OPTIONS = [
  '特效主体居中',
  '中近景',
  '广角全景',
  '关键帧主体特写'
] as const;

const CHARACTER_BACKGROUND_OPTIONS = [
  '纯白背景',
  '浅灰纯色背景',
  '纯色背景',
  '简洁渐变背景',
  '与角色设定相符的环境背景'
] as const;

const SCENE_BACKGROUND_OPTIONS = [
  '完整环境场景',
  '与场景设定相符的环境背景',
  '简洁纯色背景',
  '简洁渐变背景',
  '纯白背景'
] as const;

const PROP_BACKGROUND_OPTIONS = [
  '纯白产品背景',
  '浅灰产品背景',
  '深色产品背景',
  '简洁渐变背景',
  '与道具用途相符的环境背景'
] as const;

const EFFECT_BACKGROUND_OPTIONS = [
  '透明背景',
  '纯黑背景',
  '深色渐变背景',
  '中性纯色背景',
  '与特效场景相符的环境背景'
] as const;

const CHARACTER_ASPECT_RATIO_OPTIONS = ['2:3', '3:2', '1:1', '4:3', '16:9', '9:16'] as const;
const SCENE_ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:2', '2.39:1'] as const;
const PROP_ASPECT_RATIO_OPTIONS = ['1:1', '4:3', '3:2', '2:3', '16:9'] as const;
const EFFECT_ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:2', '2.39:1'] as const;

const PROP_STYLE_OPTIONS = [...VISUAL_STYLE_OPTIONS, '产品摄影', '微距摄影'] as const;

export const formWorkflows: readonly FormWorkflow[] = [
  {
    toolName: CREATIVE_WRITING_WORKFLOW_NAME,
    title: '创意写作',
    promptPath: 'copilot-customizations/prompts/creative-writing.prompt.md',
    resultType: 'content',
    supportsChapterContent: true,
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据已填写内容继续。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'idea', label: '创作主题或灵感', description: '填写创作主题、核心创意或灵感', placeholder: '例如：一名失忆的灯塔守夜人，每晚都会收到来自未来的求救信号' },
      { name: 'genre', label: '题材', description: '选择常用题材，也可选择其他后手动输入', options: GENRE_OPTIONS, allowCustom: true, customInputBelow: true },
      { name: 'chapterMinWords', label: '每章最少字数', description: '最低允许 200 字；常规叙事推荐设为 1000 字', placeholder: '例如：1000', defaultValue: '200', inputType: 'number', min: MIN_CHAPTER_WORDS, max: MAX_CHAPTER_WORDS, required: true },
      { name: 'chapterMaxWords', label: '每章最多字数', description: '填写每章正文的字数上限，必须大于最少字数', placeholder: '例如：2500', defaultValue: '2500', inputType: 'number', min: MIN_CHAPTER_WORDS, max: MAX_CHAPTER_WORDS, required: true },
      { name: 'maxChapters', label: '章节数上限', description: 'Copilot 会根据素材判断实际章节数，不会为达到上限而扩写', placeholder: '例如：20', defaultValue: '20', inputType: 'number', min: 1, max: MAX_GENERATED_CHAPTERS, required: true },
      { name: 'additionalInfo', label: '补充要求', description: '填写主题、人物、结构、结尾、内容边界或交付格式等要求', placeholder: '例如：主题是信任与放下；先输出创作大纲，避免血腥内容' }
    ]
  },
  {
    toolName: IMAGE_INSPIRED_WRITING_WORKFLOW_NAME,
    title: '图片灵感写作',
    promptPath: 'copilot-customizations/prompts/image-inspired-writing.prompt.md',
    resultType: 'content',
    supportsChapterContent: true,
    supportsImageAttachments: true,
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据图片和已填写内容继续。保存并运行时至少添加一张图片。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'genre', label: '题材', description: '选择常用题材，也可选择其他后手动输入', options: GENRE_OPTIONS, allowCustom: true, customInputBelow: true },
      { name: 'chapterMinWords', label: '每章最少字数', description: '最低允许 200 字；常规叙事推荐设为 1000 字', placeholder: '例如：1000', defaultValue: '200', inputType: 'number', min: MIN_CHAPTER_WORDS, max: MAX_CHAPTER_WORDS, required: true },
      { name: 'chapterMaxWords', label: '每章最多字数', description: '填写每章正文的字数上限，必须大于最少字数', placeholder: '例如：2500', defaultValue: '2500', inputType: 'number', min: MIN_CHAPTER_WORDS, max: MAX_CHAPTER_WORDS, required: true },
      { name: 'maxChapters', label: '章节数上限', description: 'Copilot 会根据素材判断实际章节数，不会为达到上限而扩写', placeholder: '例如：20', defaultValue: '20', inputType: 'number', min: 1, max: MAX_GENERATED_CHAPTERS, required: true },
      { name: 'visualElements', label: '图片中必须保留的元素', description: '填写必须保留的人物、物件、环境或构图', placeholder: '例如：保留红色雨伞、石阶和远处的灯塔' },
      { name: 'additionalInfo', label: '补充要求', description: '填写人物、情绪、结构、结尾、多图顺序或交付格式等要求', placeholder: '例如：按上传顺序展开内容，输出文章提纲，结尾保持开放' }
    ]
  },
  {
    toolName: NOVEL_RECREATION_WORKFLOW_NAME,
    title: '小说重创作',
    promptPath: 'copilot-customizations/prompts/novel-adaptation.prompt.md',
    resultType: 'content',
    supportsChapterContent: true,
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据原作和已填写内容继续。请在 Copilot 聊天中粘贴或附上原作。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'target', label: '章节形式', description: '选择正文按单章或分章交付；实际章节数受“章节数上限”控制', options: ['单章', '分章'] },
      { name: 'chapterMinWords', label: '每章最少字数', description: '最低允许 200 字；常规叙事推荐设为 1000 字', placeholder: '例如：1000', defaultValue: '200', inputType: 'number', min: MIN_CHAPTER_WORDS, max: MAX_CHAPTER_WORDS, required: true },
      { name: 'chapterMaxWords', label: '每章最多字数', description: '填写每章正文的字数上限，必须大于最少字数', placeholder: '例如：2500', defaultValue: '2500', inputType: 'number', min: MIN_CHAPTER_WORDS, max: MAX_CHAPTER_WORDS, required: true },
      { name: 'maxChapters', label: '章节数上限', description: 'Copilot 会根据原作内容判断实际章节数，不会为达到上限而扩写', placeholder: '例如：20', defaultValue: '20', inputType: 'number', min: 1, max: MAX_GENERATED_CHAPTERS, required: true },
      { name: 'preserve', label: '必须保留的内容', description: '列出必须保留的人物、情节或设定', placeholder: '例如：保留主角身份、核心谜题和原作结局' },
      { name: 'adjustments', label: '允许调整的内容', description: '说明允许删改、合并或重构的部分', placeholder: '例如：可合并支线人物，压缩中段调查过程' },
      { name: 'additionalInfo', label: '补充要求', description: '填写改编风格、题材、结局或交付格式等其他要求', placeholder: '例如：保留原作冷峻基调，先输出逐集大纲' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_character_parameters',
    title: '角色生成',
    promptPath: 'copilot-customizations/prompts/character-generation.prompt.md',
    resultType: 'prompt',
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据已填写内容继续。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'characterType', label: '角色类型', description: '选择需要生成的角色类别', options: ['人类', '动物', '怪物', '丧尸', '其他'] },
      { name: 'appearance', label: '角色外观', description: '描述年龄、性别、面部、体型、毛发及辨识特征等', placeholder: '例如：成年女性，短黑发，肩背宽阔，左眉有一道疤' },
      { name: 'clothing', label: '装束', description: '描述服装、饰物、护具或身体附属物', placeholder: '例如：破损皮夹克，颈戴旧铜项圈' },
      { name: 'expressionPose', label: '神态与姿态', description: '描述表情、动作及站立或运动姿态', placeholder: '例如：警觉地低伏身体，露出獠牙' },
      { name: 'composition', label: '视角与构图', description: '选择角色呈现方式，也可填写自定义构图', options: CHARACTER_COMPOSITION_OPTIONS, allowCustom: true },
      { name: 'style', label: '画面风格', description: '选择常用风格，也可填写自定义内容', options: VISUAL_STYLE_OPTIONS, allowCustom: true },
      { name: 'background', label: '背景', description: '选择常用背景，也可填写自定义内容', options: CHARACTER_BACKGROUND_OPTIONS, allowCustom: true },
      { name: 'aspectRatio', label: '画幅比例', description: '选择角色参考图画幅比例', options: CHARACTER_ASPECT_RATIO_OPTIONS },
      { name: 'additionalInfo', label: '补充要求', description: '填写需要保留或排除的其他画面细节', placeholder: '例如：只出现一个角色，不添加文字、水印或多余肢体' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_scene_parameters',
    title: '场景生成',
    promptPath: 'copilot-customizations/prompts/scene-generation.prompt.md',
    resultType: 'prompt',
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据已填写内容继续。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'placeType', label: '地点类型', description: '例如室内、街道、森林或特殊空间', placeholder: '例如：临河的旧仓库室内' },
      { name: 'layout', label: '空间布局', description: '描述空间分区和区域关系', placeholder: '例如：入口在南侧，中央为空地，北墙有一排货架' },
      { name: 'environment', label: '环境与光线', description: '填写时间、天气、光源或环境氛围', placeholder: '例如：凌晨大雨，头顶冷白灯，空间潮湿空旷' },
      { name: 'composition', label: '视角与构图', description: '选择场景呈现方式，也可填写自定义构图', options: SCENE_COMPOSITION_OPTIONS, allowCustom: true },
      { name: 'style', label: '画面风格', description: '选择场景常用风格，也可填写自定义内容', options: SCENE_STYLE_OPTIONS, allowCustom: true },
      { name: 'background', label: '背景', description: '选择场景背景呈现方式，也可填写自定义内容', options: SCENE_BACKGROUND_OPTIONS, allowCustom: true },
      { name: 'aspectRatio', label: '画幅比例', description: '选择场景参考图画幅比例', options: SCENE_ASPECT_RATIO_OPTIONS },
      { name: 'additionalInfo', label: '补充要求', description: '填写关键陈设、时代地域或需要排除的画面内容', placeholder: '例如：保留墙边铁柜，不出现人物、文字或水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_prop_parameters',
    title: '道具生成',
    promptPath: 'copilot-customizations/prompts/prop-generation.prompt.md',
    resultType: 'prompt',
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据已填写内容继续。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'propName', label: '道具名称', description: '填写道具名称', placeholder: '例如：刻有编号的旧铜钥匙' },
      { name: 'appearance', label: '外观特征', description: '描述尺寸、结构、材质、颜色及可见细节', placeholder: '例如：掌心大小的旧铜钥匙，细长齿纹，柄部刻有编号' },
      { name: 'state', label: '当前状态', description: '描述道具完整、破损、开启或使用中的状态', placeholder: '例如：整体完整，表面有磨损和泥渍' },
      { name: 'composition', label: '视角与构图', description: '选择道具呈现方式，也可填写自定义构图', options: PROP_COMPOSITION_OPTIONS, allowCustom: true },
      { name: 'style', label: '画面风格', description: '选择道具常用风格，也可填写自定义内容', options: PROP_STYLE_OPTIONS, allowCustom: true },
      { name: 'background', label: '背景', description: '选择道具展示背景，也可填写自定义内容', options: PROP_BACKGROUND_OPTIONS, allowCustom: true },
      { name: 'aspectRatio', label: '画幅比例', description: '选择道具参考图画幅比例', options: PROP_ASPECT_RATIO_OPTIONS },
      { name: 'additionalInfo', label: '补充要求', description: '填写时代背景、特殊功能或需要排除的画面内容', placeholder: '例如：民国时期使用，不出现手、文字或水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_effect_parameters',
    title: '特效生成',
    promptPath: 'copilot-customizations/prompts/effect-generation.prompt.md',
    resultType: 'prompt',
    notice: '任务名称为必填项；其余空字段表示该项不需要收集，Copilot 不会追问，将根据已填写内容继续。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'source', label: '特效来源', description: '说明特效来自何处', placeholder: '例如：角色手中的古老护符' },
      { name: 'appearance', label: '视觉表现', description: '描述形态、位置、颜色、亮度和影响范围', placeholder: '例如：护符周围浮现青蓝色光环，照亮半径两米范围' },
      { name: 'motion', label: '触发与变化', description: '描述触发条件、运动过程和持续时间', placeholder: '例如：接触雨水后粒子盘旋上升，约3秒后消散' },
      { name: 'environmentInteraction', label: '环境交互', description: '说明特效对人物、道具及环境的影响', placeholder: '例如：照亮角色手部，在墙面投下流动光影' },
      { name: 'composition', label: '视角与构图', description: '选择特效呈现方式，也可填写自定义构图', options: EFFECT_COMPOSITION_OPTIONS, allowCustom: true },
      { name: 'style', label: '画面风格', description: '选择特效常用风格，也可填写自定义内容', options: EFFECT_STYLE_OPTIONS, allowCustom: true },
      { name: 'background', label: '背景', description: '选择特效背景呈现方式，也可填写自定义内容', options: EFFECT_BACKGROUND_OPTIONS, allowCustom: true },
      { name: 'aspectRatio', label: '画幅比例', description: '选择特效参考图或关键帧画幅比例', options: EFFECT_ASPECT_RATIO_OPTIONS },
      { name: 'additionalInfo', label: '补充要求', description: '填写强度变化或需要排除的画面内容', placeholder: '例如：不添加文字或水印' }
    ]
  },
  {
    toolName: SCREENPLAY_WORKFLOW_NAME,
    title: '剧本创作',
    promptPath: 'copilot-customizations/prompts/screenplay.prompt.md',
    resultType: 'content',
    requiresProject: true,
    notice: '任务名称、所属项目、关联内容创作任务、单集最大时长和最大总集数为必填项；单集最大时长是上限，剧本时长将按内容决定。',
    fields: [
      {
        ...TASK_NAME_FIELD,
        description: '必填，用于在任务列表中识别这项剧本创作任务',
      },
      { name: 'sourceTaskId', label: '关联内容创作任务', description: '选择当前项目中已有生成内容的任务，生成内容将作为剧本创作素材', placeholder: '请选择创作任务', projectContentTask: true, required: true },
      { name: 'maxEpisodeDurationSeconds', label: '单集最大时长（秒）', description: '填写每集时长上限；Copilot 将按内容分析合理时长，不会为达到上限而扩写', placeholder: '例如：60', inputType: 'number', min: 1, required: true },
      { name: 'maxEpisodes', label: '最大总集数', description: '填写集数上限；短片或电影填写1', placeholder: '例如：1', inputType: 'number', min: 1, max: MAX_GENERATED_CHAPTERS, required: true },
      { name: 'additionalInfo', label: '补充要求', description: '填写人物、冲突、主题、保留项、结局或内容边界等其他要求', placeholder: '例如：保留灯塔和未来求救信号设定，避免血腥描写' }
    ]
  },
  {
    toolName: SHOOTING_SCRIPT_WORKFLOW_NAME,
    title: '拍摄脚本制作',
    promptPath: 'copilot-customizations/prompts/shooting-script.prompt.md',
    resultType: 'content',
    requiresProject: true,
    notice: '任务名称、所属项目和关联剧本任务为必填项；其余空字段表示该项不需要收集，Copilot 不会追问。',
    fields: [
      TASK_NAME_FIELD,
      { name: 'screenplayTaskId', label: '关联剧本任务', description: '选择当前项目中已生成剧本的剧本创作任务', placeholder: '请选择剧本创作任务', projectContentTask: true, projectTaskCategory: SCREENPLAY_WORKFLOW_NAME, required: true },
      { name: 'aspectRatio', label: '画幅比例', description: '选择目标视频画幅', options: ['16:9', '9:16', '1:1', '4:3', '2.39:1'] },
      { name: 'visualStyle', label: '画面风格', description: '选择常用风格，也可填写自定义内容', options: VISUAL_STYLE_OPTIONS, allowCustom: true },
      { name: 'additionalInfo', label: '补充要求', description: '填写镜头节奏、连续性、声音、模型或其他制作限制', placeholder: '例如：共12个镜头，保留关键对白，不出现字幕和水印' }
    ]
  }
];

/** 根据工作流标识获取其结果类型；未知标识会明确报错。 */
export function getWorkflowResultType(workflowName: string): WorkflowResultType {
  const workflow = formWorkflows.find((item) => item.toolName === workflowName);
  if (!workflow) {
    throw new Error('创作结果对应的工作流标识无效。');
  }

  return workflow.resultType;
}

/** 判断工作流是否要求按章提交创作结果。 */
export function isChapterContentWorkflow(workflowName: string): boolean {
  return formWorkflows.some((workflow) =>
    workflow.toolName === workflowName && workflow.supportsChapterContent === true
  );
}