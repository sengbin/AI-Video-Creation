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
      { name: 'theme', label: '主题与核心表达', description: '填写故事主题或希望讨论的问题', placeholder: '例如：亲情、信任与放下；当真相会伤害所爱之人时，是否还应该说出来？' },
      { name: 'genre', label: '题材', description: '例如悬疑、爱情、科幻', placeholder: '例如：悬疑科幻' },
      { name: 'duration', label: '目标时长', description: '填写作品目标总时长', placeholder: '例如：总时长约10分钟' },
      { name: 'episodeCount', label: '集数', description: '填写目标集数', placeholder: '例如：6集' },
      { name: 'era', label: '时代背景', description: '填写故事发生的时代背景', placeholder: '例如：近未来的沿海城市' },
      { name: 'characterCount', label: '主要人物数量', description: '填写主要人物数量', placeholder: '例如：3位主要人物' },
      { name: 'style', label: '表达风格', description: '填写期望的故事风格', placeholder: '例如：节奏紧凑、写实克制，结尾留有余味' },
      { name: 'ending', label: '结局方向', description: '填写期望的结局方向', placeholder: '例如：真相揭晓，但主角需要作出艰难选择' },
      { name: 'boundaries', label: '内容边界', description: '填写需要遵守或避免的内容', placeholder: '例如：避免血腥画面，不出现未成年人受伤' },
      { name: 'deliverable', label: '交付格式', description: '例如故事梗概、剧情大纲、分集结构或剧本', placeholder: '例如：先输出一句话梗概和完整故事大纲' },
      { name: 'phase', label: '创作阶段', description: '填写当前希望完成的创作阶段', placeholder: '例如：先完成故事梗概，暂不写分场剧本' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_image_story_parameters',
    title: '图片写故事',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据图片和已填写内容继续。请在 Copilot 聊天中附上图片。',
    fields: [
      { name: 'genre', label: '题材', description: '例如悬疑、奇幻、现实题材', placeholder: '例如：带有奇幻元素的悬疑故事' },
      { name: 'duration', label: '目标时长', description: '填写作品目标总时长', placeholder: '例如：约8分钟' },
      { name: 'episodeCount', label: '集数', description: '填写目标集数', placeholder: '例如：4集' },
      { name: 'protagonist', label: '主角身份', description: '说明故事主角的身份定位', placeholder: '例如：以画面中的背包旅人为主角' },
      { name: 'relationships', label: '人物关系', description: '说明图片中人物关系或指定的关系设定', placeholder: '例如：两人是多年未见的母女' },
      { name: 'storyType', label: '故事类型', description: '填写希望采用的故事类型', placeholder: '例如：误会逐步解开的温情故事' },
      { name: 'tone', label: '情绪基调', description: '填写希望呈现的情绪基调', placeholder: '例如：克制、温暖，带一点遗憾' },
      { name: 'ending', label: '结局方向', description: '填写期望的结局方向', placeholder: '例如：开放式结尾，留下和解的可能' },
      { name: 'visualElements', label: '图片中必须保留的元素', description: '填写必须保留的人物、物件、环境或构图', placeholder: '例如：保留红色雨伞、石阶和远处的灯塔' },
      { name: 'deliverable', label: '交付格式', description: '例如故事梗概、剧情大纲、分集结构或剧本', placeholder: '例如：输出故事梗概和分集大纲' },
      { name: 'phase', label: '创作阶段', description: '填写当前希望完成的创作阶段', placeholder: '例如：先完成故事梗概' },
      { name: 'imageOrder', label: '多张图片的顺序', description: '说明图片之间的先后顺序', placeholder: '例如：按上传顺序作为故事发生顺序' },
      { name: 'imageRelationships', label: '多张图片的关联方式', description: '说明图片之间的人物、地点或剧情关系', placeholder: '例如：第1张和第2张是同一地点的不同时刻' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_novel_parameters',
    title: '小说重创作',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据原作和已填写内容继续。请在 Copilot 聊天中粘贴或附上原作。',
    fields: [
      { name: 'target', label: '改编目标', description: '例如短片、短剧、分集剧本', placeholder: '例如：改编为8集竖屏短剧' },
      { name: 'scope', label: '目标篇幅', description: '填写总时长或集数及单集时长', placeholder: '例如：总时长约40分钟；或8集、每集约5分钟' },
      { name: 'positioning', label: '题材定位', description: '填写改编后的题材定位', placeholder: '例如：都市悬疑、女性成长' },
      { name: 'style', label: '改编风格', description: '填写期望的改编风格', placeholder: '例如：节奏紧凑，保留原作冷峻基调' },
      { name: 'preserve', label: '必须保留的内容', description: '列出必须保留的人物、情节或设定', placeholder: '例如：保留主角身份、核心谜题和原作结局' },
      { name: 'adjustments', label: '允许调整的内容', description: '说明允许删改、合并或重构的部分', placeholder: '例如：可合并支线人物，压缩中段调查过程' },
      { name: 'ending', label: '结局方向', description: '说明结局方向或希望保留的原作结局', placeholder: '例如：保留原作结局，但提前揭示关键线索' },
      { name: 'deliverable', label: '交付格式', description: '例如改编梗概、分集大纲、场次大纲或剧本', placeholder: '例如：先输出改编梗概和逐集大纲' },
      { name: 'phase', label: '改编阶段', description: '填写当前希望完成的改编阶段', placeholder: '例如：先完成分集大纲，暂不写台词' }
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
      { name: 'audience', label: '目标受众', description: '填写主要受众', placeholder: '例如：成年观众' },
      { name: 'theme', label: '主题与核心表达', description: '填写主题或希望讨论的问题', placeholder: '例如：信任与放下' },
      { name: 'characters', label: '主要人物', description: '列出人物身份、目标或已确认关系', placeholder: '例如：守夜人想查明信号来源；电台工程师试图阻止他' },
      { name: 'coreConflict', label: '核心冲突', description: '填写推动故事的主要阻碍或对抗', placeholder: '例如：每次回应信号都会改变现实中的一段记忆' },
      { name: 'mustKeep', label: '必须保留', description: '填写不能改变的情节、设定或结局', placeholder: '例如：灯塔、未来求救信号和主角失忆设定' },
      { name: 'allowedChanges', label: '允许调整', description: '填写允许压缩、合并或新增的内容', placeholder: '例如：允许合并配角，不改动结局方向' },
      { name: 'tone', label: '风格与情绪基调', description: '填写期望的表达风格', placeholder: '例如：写实克制，结尾留有余味' },
      { name: 'ending', label: '结局方向', description: '填写结局方向；不指定可留空', placeholder: '例如：主角救下求救者，但失去最后一段记忆' },
      { name: 'deliverable', label: '交付要求', description: '填写剧本格式或当前创作阶段', placeholder: '例如：标准分场剧本，含场景标题、动作和对白' },
      { name: 'boundaries', label: '内容边界', description: '填写需要遵守或避免的内容', placeholder: '例如：避免血腥描写，不出现未成年人受伤' }
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
      { name: 'shotCount', label: '镜头数量或节奏', description: '填写镜头数量或期望剪辑节奏', placeholder: '例如：约12个镜头，节奏逐步加快' },
      { name: 'shotDuration', label: '单镜头时长', description: '填写单镜头时长范围或节奏要求', placeholder: '例如：每镜头约3至6秒，关键反应镜头可更长' },
      { name: 'visualStyle', label: '画面风格', description: '填写整体视觉风格', placeholder: '例如：写实电影质感，冷色调，低照度' },
      { name: 'cameraStyle', label: '摄影机与镜头风格', description: '填写景别、机位或运动偏好', placeholder: '例如：以稳定中近景为主，揭示真相时缓慢推进' },
      { name: 'continuity', label: '连续性锚点', description: '填写跨镜头需要保持一致的人物、服装、道具或空间信息', placeholder: '例如：主角左手始终握着铜钥匙，灯塔主灯从右向左旋转' },
      { name: 'audio', label: '对白与声音', description: '填写对白、环境声、音乐或静音要求', placeholder: '例如：保留关键对白，以海风和电台噪声营造氛围' },
      { name: 'generationModel', label: '目标视频生成模型', description: '填写目标模型名称；未指定可留空', placeholder: '例如：填写实际使用的视频生成模型名称' },
      { name: 'deliverable', label: '交付结构', description: '填写镜头表字段或其他交付要求', placeholder: '例如：按场次分组，列出镜号、时长、景别、动作、运镜、声音和视频提示词' },
      { name: 'constraints', label: '制作与内容限制', description: '填写必须遵守或排除的要求', placeholder: '例如：总时长不超过3分钟，不新增人物，不出现字幕和水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_character_parameters',
    title: '角色生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'name', label: '角色名称或代号', description: '填写用于区分角色的名称', placeholder: '例如：林晚、黑森林巨狼' },
      { name: 'characterType', label: '角色类型', description: '选择需要生成的角色类别', options: ['人类', '动物', '怪物', '丧尸', '其他'] },
      { name: 'age', label: '年龄或生命阶段', description: '填写适用的年龄或成长阶段', placeholder: '例如：28岁、幼年、成年' },
      { name: 'gender', label: '性别特征', description: '填写适用的性别或雌雄特征；不适用可留空', placeholder: '例如：女性、雄性' },
      { name: 'appearance', label: '外观特征', description: '描述可见的面部、头部、肤色或表面特征', placeholder: '例如：深棕色眼睛、灰白皮毛、额头有角质突起' },
      { name: 'body', label: '体型与身体结构', description: '描述体型、比例、肢体数量及特殊结构', placeholder: '例如：肩背宽阔，双臂修长，背后有一对骨翼' },
      { name: 'hairstyle', label: '毛发与头部特征', description: '描述发型、毛发、羽毛、鳞甲或其他头部特征', placeholder: '例如：黑色短发；或颈部覆盖蓬松的银灰色鬃毛' },
      { name: 'clothing', label: '装束与附属物', description: '描述适用的服装、饰物、护具或身体附属物', placeholder: '例如：破损皮夹克；或颈戴旧铜项圈' },
      { name: 'distinctiveFeatures', label: '辨识特征', description: '填写需要保留的明显外观细节', placeholder: '例如：左眼发出微弱红光，右耳缺损' },
      { name: 'expressionPose', label: '神态与姿态', description: '描述表情、动作及站立或运动姿态', placeholder: '例如：警觉地低伏身体，露出獠牙' },
      { name: 'composition', label: '视角与构图', description: '说明角色呈现范围、视角及构图方式', placeholder: '例如：正面全身像，角色居中，四肢完整入画' },
      { name: 'style', label: '画面风格', description: '填写角色图像的视觉风格', placeholder: '例如：写实电影角色设定图，柔和棚拍光线' },
      { name: 'background', label: '背景', description: '描述背景颜色、环境或简洁程度', placeholder: '例如：浅灰纯色背景，无其他物体' },
      { name: 'aspectRatio', label: '画幅比例', description: '选择角色参考图画幅比例', options: ['2:3', '3:2', '1:1', '4:3', '16:9', '9:16'] },
      { name: 'toolLimits', label: '生成限制', description: '填写需要遵守或排除的画面要求', placeholder: '例如：仅出现一个角色，不添加文字、水印或多余肢体' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_scene_parameters',
    title: '场景生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'placeType', label: '地点类型', description: '例如室内、街道、森林或特殊空间', placeholder: '例如：临河的旧仓库室内' },
      { name: 'era', label: '时代', description: '填写场景所处时代', placeholder: '例如：1990年代末' },
      { name: 'region', label: '地域', description: '填写场景所在地域', placeholder: '例如：中国南方沿海城市' },
      { name: 'spaceSize', label: '空间尺寸', description: '填写空间大小或主要尺寸', placeholder: '例如：约20米长、12米宽的单层空间' },
      { name: 'layout', label: '空间布局', description: '描述空间分区和区域关系', placeholder: '例如：入口在南侧，中央为空地，北墙有一排货架' },
      { name: 'entrances', label: '出入口', description: '说明门、窗及其他出入口位置', placeholder: '例如：南侧卷帘门，东墙有一扇高窗' },
      { name: 'fixtures', label: '关键陈设', description: '列出对剧情或画面重要的固定陈设', placeholder: '例如：中央木桌、墙边铁柜、地面散落的纸箱' },
      { name: 'time', label: '时间', description: '填写场景发生的时间', placeholder: '例如：凌晨两点' },
      { name: 'weather', label: '天气', description: '填写场景天气', placeholder: '例如：室外大雨，雨水从门缝渗入' },
      { name: 'light', label: '光源', description: '说明主要光源及光线方向', placeholder: '例如：头顶一盏冷白灯，门外有路灯侧光' },
      { name: 'atmosphere', label: '环境气氛', description: '描述场景氛围', placeholder: '例如：潮湿、空旷，带有久无人居的压抑感' },
      { name: 'style', label: '视觉风格', description: '填写场景画面风格', placeholder: '例如：写实电影质感，低饱和冷色调' },
      {
        name: 'aspectRatio',
        label: '画幅',
        description: '例如 16:9、9:16',
        options: ['16:9', '9:16', '1:1', '4:3', '3:2', '2.39:1']
      },
      { name: 'toolLimits', label: '生成限制', description: '填写其他需要遵守或排除的画面要求', placeholder: '例如：画面中不出现人物、文字或水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_prop_parameters',
    title: '道具生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'propName', label: '道具名称', description: '填写道具名称', placeholder: '例如：刻有编号的旧铜钥匙' },
      { name: 'era', label: '时代背景', description: '填写道具所处的时代', placeholder: '例如：民国时期' },
      { name: 'size', label: '尺寸', description: '填写道具尺寸或相对比例', placeholder: '例如：约8厘米长，可握在掌心' },
      { name: 'material', label: '材质', description: '填写道具材质', placeholder: '例如：氧化发暗的黄铜' },
      { name: 'color', label: '颜色', description: '填写道具颜色', placeholder: '例如：暗金色，边缘有绿色铜锈' },
      { name: 'structure', label: '结构', description: '描述道具结构', placeholder: '例如：细长钥匙齿，柄部有圆形编号牌' },
      { name: 'ability', label: '特殊能力', description: '填写道具特殊能力或功能', placeholder: '例如：无特殊能力，仅用于开启对应的旧锁' },
      { name: 'state', label: '外观状态', description: '描述道具当前状态，如完整、破损或开启', placeholder: '例如：整体完整，表面有磨损和泥渍' },
      { name: 'style', label: '画面风格', description: '说明道具参考图的视觉风格', placeholder: '例如：写实微距产品摄影，深色背景' },
      { name: 'toolLimits', label: '生成限制', description: '填写需要遵守或排除的画面要求', placeholder: '例如：单件道具居中展示，不出现手、文字或水印' }
    ]
  },
  {
    toolName: 'ai-video-creation-tools_collect_effect_parameters',
    title: '特效生成',
    notice: '空字段表示该项不需要收集，Copilot 不会追问；将根据已填写内容继续。',
    fields: [
      { name: 'source', label: '特效来源', description: '说明特效来自何处', placeholder: '例如：角色手中的古老护符' },
      { name: 'trigger', label: '触发条件', description: '说明特效在什么条件下触发', placeholder: '例如：护符接触雨水后开始发光' },
      { name: 'location', label: '发生位置', description: '填写特效发生的位置', placeholder: '例如：角色手掌周围，光效向上升起' },
      { name: 'duration', label: '持续时间', description: '填写特效持续时间', placeholder: '例如：约3秒，随后逐渐消散' },
      { name: 'movementDirection', label: '运动方向', description: '描述特效的运动方向', placeholder: '例如：粒子由地面盘旋上升至空中' },
      { name: 'range', label: '影响范围', description: '描述特效覆盖或影响的范围', placeholder: '例如：半径约两米，不覆盖整个房间' },
      { name: 'color', label: '颜色', description: '填写特效颜色', placeholder: '例如：青蓝色为主，边缘带少量白光' },
      { name: 'brightness', label: '亮度', description: '描述特效亮度', placeholder: '例如：明亮但不产生过曝' },
      { name: 'form', label: '视觉形态', description: '描述特效的形状或视觉形态', placeholder: '例如：细小光点组成不完整的环形' },
      { name: 'intensity', label: '强度', description: '描述特效强弱', placeholder: '例如：由微弱脉动逐渐增强后稳定' },
      { name: 'environmentInteraction', label: '环境交互', description: '说明特效对人物、道具及环境的影响', placeholder: '例如：照亮角色手部，在墙面投下流动光影' },
      { name: 'cameraView', label: '镜头视角', description: '说明镜头视角或观察方式', placeholder: '例如：中近景，略低机位，主体位于画面中央' },
      { name: 'style', label: '视觉风格', description: '填写特效画面风格', placeholder: '例如：写实电影特效，细腻体积光' },
      { name: 'toolLimits', label: '生成限制', description: '填写需要遵守或排除的画面要求', placeholder: '例如：竖幅9:16，单一效果主体，不添加文字或水印' }
    ]
  }
];