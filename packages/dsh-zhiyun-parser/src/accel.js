import { ParserError } from './errors.js';

/**
 * 加速档位：**只降本、不改语义**的那几个请求旋钮。
 *
 * # 为什么未给的字段一律不发送
 *
 * 宿主（`llm.resolveModelInfo` / `prepareCall`）会为每个模型材料化自己的默认值，
 * 其中 `reasoningEffort` 的默认还取决于模型声明了哪些档位。插件在这里猜一个默认值
 * = 把宿主的默认**覆盖成插件的猜测**，而后果是静默的质量变化：用户没动过任何设置，
 * 解析却从「会思考」变成「不思考」。所以 `accel` 的每一格都是**可选的**，
 * 不给 = 不发送 = 由宿主决定；`{}` 与「不配 accel」在请求上完全等价。
 *
 * # 为什么档位按阶段分而不是全局一个
 *
 * 三阶段的成本结构与风险不同：看图阶段被思考吃光预算会让正文一个字都写不出来，
 * 而标注阶段是短答题卡。分阶段才能只压一个、不动另一个 —— 全局开关会把两者绑死。
 *
 * 取值为**原样透传**（含 ParserError 的 code）是为了让配置错误在开跑前就报出来，
 * 而不是等某一次调用以一个看不懂的协议错误失败。
 */

/** 档位名的形状检查（具体取值域由宿主模型声明决定，这里只拦明显写错的）。
 *
 * ⚠️ 不做「猜一个近似的档位名」这类纠正：写错档位名 = 静默换了模型行为，
 *    比直接报错难查得多（与 Dart `FusionAccelConfig.validate` 同一口径）。
 */
export const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/i;

const STAGE_FIELDS = new Set(['maxTokens', 'reasoningEffort']);
export const ACCEL_STAGES = ['faithful', 'mix', 'tags', 'outline'];
const ACCEL_FIELDS = new Set(['escalation', ...ACCEL_STAGES]);
/** 升档的默认倍数与硬顶（与 Dart `FusionAccelConfig` 同值）。 */
export const DEFAULT_ESCALATION_FACTOR = 2;
export const DEFAULT_ESCALATION_CEILING = 131072;

function fail(message) { throw new ParserError('CONFIG', `加速档位：${message}`); }

/** 归一一个阶段的档位；给不出可用值就报错（不静默丢弃）。 */
function normalizeStage(stage, raw) {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${stage} 的档位必须是 { maxTokens?, reasoningEffort? }`);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!STAGE_FIELDS.has(key)) fail(`${stage} 不认识字段 ${key}（只支持 maxTokens / reasoningEffort）`);
    if (value === undefined) continue;
    if (key === 'maxTokens') {
      // 0 = 不传该字段（由端点自定上限），与 Dart 的 `FusionAccelConfig` 同口径。
      if (value === 0) continue;
      if (!Number.isSafeInteger(value) || value < 0) fail(`${stage} 的 maxTokens 必须是非负整数（0 = 不传该字段）`);
      out.maxTokens = value;
      continue;
    }
    if (typeof value !== 'string' || !REASONING_EFFORT_PATTERN.test(value.trim())) {
      fail(`${stage} 的 reasoningEffort 必须是非空档位名（取值域由宿主模型声明决定）`);
    }
    out.reasoningEffort = value.trim();
  }
  return out;
}

/**
 * 归一截断升档策略。
 *
 * `false` = 明确关掉；`{}` = 打开但什么都没配 → 打开且不生效（不改行为）。
 * 这两种写法在请求上都是零影响，区别只在「有没有打算以后配」。
 */
function normalizeEscalation(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { factor: DEFAULT_ESCALATION_FACTOR, ceiling: DEFAULT_ESCALATION_CEILING, promote: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('accel.escalation 必须是 { maxTokens?, reasoningEffort?, factor?, ceiling? } 或 false');
  const promote = normalizeStage('escalation', { maxTokens: raw.maxTokens, reasoningEffort: raw.reasoningEffort }) ?? {};
  // 三个字段都配不出升档预算 → 升档没有落点，如实报出来（不许静默当成开了）。
  const issues = Object.keys(promote).length ? [] : ['accel.escalation 既没有 maxTokens 也没有 reasoningEffort：截断时没有升档预算可用，升档不会触发'];
  const factor = raw.factor === undefined ? DEFAULT_ESCALATION_FACTOR : raw.factor;
  if (!Number.isFinite(factor) || factor <= 1) fail('accel.escalation.factor 必须大于 1（否则截断升档不会真的抬高预算）');
  const ceiling = raw.ceiling === undefined ? DEFAULT_ESCALATION_CEILING : raw.ceiling;
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) fail('accel.escalation.ceiling 必须是正整数');
  for (const key of Object.keys(raw)) {
    if (!['maxTokens', 'reasoningEffort', 'factor', 'ceiling'].includes(key)) fail(`accel.escalation 不认识字段 ${key}`);
  }
  // 硬顶必须真的能压住升档预算：反过来（硬顶 < 升档预算）会让「硬顶」形同虚设，
  // 而外在表现是"配了上限却照样发出更大的预算" —— 报出来，不悄悄纠正。
  if (promote.maxTokens !== undefined && ceiling < promote.maxTokens) {
    fail(`accel.escalation.ceiling（${ceiling}）小于升档预算（${promote.maxTokens}）：那样硬顶压不住升档，等于没有上限`);
  }
  return { factor, ceiling, promote, issues };
}

/**
 * 归一 `accel` 配置。
 *
 * @param raw 插件 config 或构造函数给的 `{ faithful|mix|tags|outline: {...}, escalation: {...} }`。
 * @returns `{ stages, escalation, issues }`；`stages[stage]` 为 `null` = 该阶段一个字段都不加。
 */
export function normalizeAccel(raw) {
  if (raw === undefined || raw === null) return { stages: {}, escalation: null, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('accel 必须是 { faithful|mix|tags|outline|escalation: {...} }');
  const stages = {};
  const issues = [];
  let escalation = null;
  for (const [name, value] of Object.entries(raw)) {
    if (!ACCEL_FIELDS.has(name)) { issues.push(`accel 里的 ${name} 不是可配项（只支持 ${[...ACCEL_FIELDS].join('/')}），已忽略`); continue; }
    if (name === 'escalation') {
      escalation = normalizeEscalation(value);
      if (escalation) issues.push(...escalation.issues);
      continue;
    }
    const stage = normalizeStage(name, value);
    if (stage && Object.keys(stage).length) stages[name] = stage;
  }
  return { stages, escalation, issues };
}

/**
 * 把某阶段的档位并进路由配置。
 *
 * 只覆盖给了的字段：`accel` 少给一个字段不会把宿主/路由那边已经定的值抹掉
 * （`{ maxTokens }` 只改预算，不动 `reasoningEffort`）。
 */
export function applyAccel(route, stageAccel) {
  if (!stageAccel) return route;
  return { ...route, ...stageAccel };
}

/**
 * 截断升档要用的预算倍数：先按倍数抬，再夹到硬顶。
 *
 * 纯函数是为了可测：这条路径只在真机撞上限时才走到，而「撞上限」正是最怕的
 * 那类故障，必须能离线钉死（与 Dart `escalatedBudget` 同口径）。
 *
 * ⚠️ 倍数非法（≤ 1 或非有限）时**不抬**：抬到一个更小的值比不抬更糟。
 */
export function escalatedBudget({ current, factor = DEFAULT_ESCALATION_FACTOR, ceiling = DEFAULT_ESCALATION_CEILING }) {
  if (!Number.isFinite(factor) || factor <= 1) return current;
  if (!Number.isFinite(current) || current <= 0) return current;
  const next = Math.floor(current * factor);
  if (next <= current) return current;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return next;
  return next > ceiling ? ceiling : next;
}
