export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
}

export interface FormWorkflow {
  readonly toolName: string;
  readonly title: string;
  readonly notice: string;
  readonly fields: readonly FormField[];
}

export type FormValues = Record<string, string>;

export const formWorkflows: readonly FormWorkflow[] = [
  {
    toolName: 'ai-video-creation-tools_collect_story_parameters',
    title: '创意写故事',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'idea', label: '核心创意或故事种子', description: '填写创意、灵感或故事种子', placeholder: '例如：一名失忆的灯塔守夜人，每晚都会收到来自未来的求救信号' },
      { name: 'genre', label: '题材', description: '例如悬疑、爱情、科幻', placeholder: '例如：悬疑科幻' },
      { name: 'duration', label: '目标篇幅', description: '填写目标时长或集数', placeholder: '例如：约10分钟；或6集、每集约5分钟' },
      { name: 'style', label: '表达风格', description: '填写期望的故事风格', placeholder: '例如：节奏紧凑、写实克制，结尾留有余味' },
      { name: 'additionalInfo', label: '补充要求', description: '填写主题、人物数量、结局、内容边界或交付格式等其他要求', placeholder: '例如：主题是信任与放下；先输出故事大纲，避免血腥内容' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_image_story_parameters',
    title: '图片写故事',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据图片和已填写内容继续。请在 Copilot 聊天中附上图片。',
    fields: [
      { name: 'genre', label: '题材', description: '例如悬疑、奇幻、现实题材', placeholder: '例如：带有奇幻元素的悬疑故事' },
      { name: 'duration', label: '目标篇幅', description: '填写目标时长或集数', placeholder: '例如：约8分钟；或4集、每集约5分钟' },
      { name: 'visualElements', label: '图片中必须保留的元素', description: '填写必须保留的人物、物件、环境或构图', placeholder: '例如：保留红色雨伞、石阶和远处的灯塔' },
      { name: 'additionalInfo', label: '补充要求', description: '填写主角、人物关系、情绪、结局、多图顺序或交付格式等要求', placeholder: '例如：按上传顺序发展故事，输出分集大纲，结尾保持开放' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_novel_parameters',
    title: '小说重创作',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据原作和已填写内容继续。请在 Copilot 聊天中粘贴或附上原作。',
    fields: [
      { name: 'target', label: '改编目标', description: '例如短片、短剧、分集剧本', placeholder: '例如：改编为8集竖屏短剧' },
      { name: 'scope', label: '目标篇幅', description: '填写总时长或集数及单集时长', placeholder: '例如：总时长约40分钟；或8集、每集约5分钟' },
      { name: 'preserve', label: '必须保留的内容', description: '列出必须保留的人物、情节或设定', placeholder: '例如：保留主角身份、核心谜题和原作结局' },
      { name: 'adjustments', label: '允许调整的内容', description: '说明允许删改、合并或重构的部分', placeholder: '例如：可合并支线人物，压缩中段调查过程' },
      { name: 'additionalInfo', label: '补充要求', description: '填写改编风格、题材、结局或交付格式等其他要求', placeholder: '例如：保留原作冷峻基调，先输出逐集大纲' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_screenplay_parameters',
    title: '剧本创作',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；故事创意或原作也可以粘贴到聊天或作为附件提供。',
    fields: [
      { name: 'sourceMaterial', label: '故事创意或原作材料', description: '填写创意、梗概或改编依据；长篇材料可附加到聊天', placeholder: '例如：一名失忆的灯塔守夜人，每晚都会收到来自未来的求救信号' },
      { name: 'format', label: '剧本形态', description: '填写短片、短剧单集、分集剧本等', placeholder: '例如：10分钟悬疑短片剧本' },
      { name: 'genre', label: '题材类型', description: '填写剧本题材', placeholder: '例如：悬疑科幻' },
      { name: 'duration', label: '目标时长或集数', description: '填写总时长、集数及单集时长', placeholder: '例如：总长10分钟；或6集、每集约5分钟' },
      { name: 'additionalInfo', label: '补充要求', description: '填写人物、冲突、主题、保留项、结局或内容边界等其他要求', placeholder: '例如：保留灯塔和未来求救信号设定，避免血腥描写' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_shooting_script_parameters',
    title: '拍摄脚本制作',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；故事、分场大纲或剧本也可以粘贴到聊天或作为附件提供。',
    fields: [
      { name: 'scriptSource', label: '故事或剧本依据', description: '填写故事梗概、分场大纲或剧本；长篇材料可附加到聊天', placeholder: '例如：主角在灯塔收到来自未来的求救信号，调查后发现信号来自自己' },
      { name: 'duration', label: '目标总时长', description: '填写总时长或单集时长', placeholder: '例如：约3分钟；或每集约5分钟' },
      { name: 'aspectRatio', label: '画幅比例', description: '选择目标视频画幅', options: ['16:9', '9:16', '1:1', '4:3', '2.39:1'] },
      { name: 'visualStyle', label: '画面风格', description: '填写整体视觉风格', placeholder: '例如：写实电影质感，冷色调，低照度' },
      { name: 'cameraStyle', label: '摄影机与镜头风格', description: '填写景别、机位或运动偏好', placeholder: '例如：以稳定中近景为主，揭示真相时缓慢推进' },
      { name: 'additionalInfo', label: '补充要求', description: '填写镜头节奏、连续性、声音、模型或其他制作限制', placeholder: '例如：共12个镜头，保留关键对白，不出现字幕和水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_character_parameters',
    title: '角色生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'characterType', label: '角色类型', description: '选择需要生成的角色类别', options: ['人类', '动物', '怪物', '丧尸', '其他'] },
      { name: 'appearance', label: '角色外观', description: '描述年龄、性别、面部、体型、毛发及辨识特征等', placeholder: '例如：成年女性，短黑发，肩背宽阔，左眉有一道疤' },
      { name: 'clothing', label: '装束', description: '描述服装、饰物、护具或身体附属物', placeholder: '例如：破损皮夹克，颈戴旧铜项圈' },
      { name: 'expressionPose', label: '神态与姿态', description: '描述表情、动作及站立或运动姿态', placeholder: '例如：警觉地低伏身体，露出獠牙' },
      { name: 'composition', label: '视角与构图', description: '说明景别、视角及角色在画面中的呈现方式', placeholder: '例如：正面全身像，角色居中，四肢完整入画' },
      { name: 'style', label: '画面风格', description: '填写角色图像的视觉风格', placeholder: '例如：写实电影角色设定图，柔和棚拍光线' },
      { name: 'background', label: '背景', description: '描述背景颜色、环境或简洁程度', placeholder: '例如：浅灰纯色背景，无其他物体' },
      { name: 'aspectRatio', label: '画幅比例', description: '选择角色参考图画幅比例', options: ['2:3', '3:2', '1:1', '4:3', '16:9', '9:16'] },
      { name: 'additionalInfo', label: '补充要求', description: '填写需要保留或排除的其他画面细节', placeholder: '例如：只出现一个角色，不添加文字、水印或多余肢体' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_scene_parameters',
    title: '场景生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'placeType', label: '地点类型', description: '例如室内、街道、森林或特殊空间', placeholder: '例如：临河的旧仓库室内' },
      { name: 'layout', label: '空间布局', description: '描述空间分区和区域关系', placeholder: '例如：入口在南侧，中央为空地，北墙有一排货架' },
      { name: 'environment', label: '环境与光线', description: '填写时间、天气、光源或环境氛围', placeholder: '例如：凌晨大雨，头顶冷白灯，空间潮湿空旷' },
      { name: 'composition', label: '视角与构图', description: '说明观察视角和画面重点', placeholder: '例如：从入口向内的广角全景，中央桌面为视觉重点' },
      { name: 'style', label: '视觉风格', description: '填写场景画面风格', placeholder: '例如：写实电影质感，低饱和冷色调' },
      { name: 'aspectRatio', label: '画幅', description: '选择目标图片画幅', options: ['16:9', '9:16', '1:1', '4:3', '3:2', '2.39:1'] },
      { name: 'additionalInfo', label: '补充要求', description: '填写关键陈设、时代地域或需要排除的画面内容', placeholder: '例如：保留墙边铁柜，不出现人物、文字或水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_prop_parameters',
    title: '道具生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'propName', label: '道具名称', description: '填写道具名称', placeholder: '例如：刻有编号的旧铜钥匙' },
      { name: 'appearance', label: '外观特征', description: '描述尺寸、结构、材质、颜色及可见细节', placeholder: '例如：掌心大小的旧铜钥匙，细长齿纹，柄部刻有编号' },
      { name: 'state', label: '当前状态', description: '描述道具完整、破损、开启或使用中的状态', placeholder: '例如：整体完整，表面有磨损和泥渍' },
      { name: 'composition', label: '视角与构图', description: '说明道具在画面中的呈现方式', placeholder: '例如：单件道具居中，略微俯视的近景' },
      { name: 'style', label: '画面风格', description: '说明道具参考图的视觉风格', placeholder: '例如：写实微距产品摄影，深色背景' },
      { name: 'additionalInfo', label: '补充要求', description: '填写时代背景、特殊功能或需要排除的画面内容', placeholder: '例如：民国时期使用，不出现手、文字或水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_effect_parameters',
    title: '特效生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'source', label: '特效来源', description: '说明特效来自何处', placeholder: '例如：角色手中的古老护符' },
      { name: 'appearance', label: '视觉表现', description: '描述形态、位置、颜色、亮度和影响范围', placeholder: '例如：护符周围浮现青蓝色光环，照亮半径两米范围' },
      { name: 'motion', label: '触发与变化', description: '描述触发条件、运动过程和持续时间', placeholder: '例如：接触雨水后粒子盘旋上升，约3秒后消散' },
      { name: 'environmentInteraction', label: '环境交互', description: '说明特效对人物、道具及环境的影响', placeholder: '例如：照亮角色手部，在墙面投下流动光影' },
      { name: 'composition', label: '视角与构图', description: '说明镜头视角和特效在画面中的位置', placeholder: '例如：略低机位中近景，主体位于画面中央' },
      { name: 'style', label: '视觉风格', description: '填写特效画面风格', placeholder: '例如：写实电影特效，细腻体积光' },
      { name: 'additionalInfo', label: '补充要求', description: '填写画幅、强度变化或需要排除的画面内容', placeholder: '例如：竖幅9:16，不添加文字或水印' }
    ]
  }
];