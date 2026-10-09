// Comparison only: retain the model's original typography in the displayed text.
export const correctionPolicy = Object.freeze({ maxEditRatio: 0.8, maxEditDistance: 80 });
const mathCommands = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', ln: 'ln', log: 'log', exp: 'exp',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', approx: '≈',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
});
function comparisonMath(math) {
  // Keep a separator until command tokenization; deleting \, first would
  // incorrectly turn \theta\,d into the unknown command \thetad.
  let value = math.replace(/\\(?:quad|qquad)\b|\\[,;:! ]/gu, ' ');
  // Only known commands and transparent wrappers are normalized. Unknown
  // commands remain visible to the guard instead of silently losing content.
  for (let i = 0; i < 8; i++) {
    const next = value.replace(/\\(?:mathrm|mathbf|mathit|mathsf|mathtt|boldsymbol|text|operatorname)\{([^{}]*)\}/gu, '$1');
    if (next === value) break; value = next;
  }
  return value.replace(/\\([a-zA-Z]+)/gu, (command, name) => mathCommands[name] ?? command)
    .replace(/[_^]\{([^{}]*)\}/gu, '$1').replace(/[_^]([a-zA-Z0-9α-ωΑ-Ω])/gu, '$1');
}
export function correctionComparison(text) {
  return text.replace(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gu,
    (_, display, inline, parens, brackets) => comparisonMath(display ?? inline ?? parens ?? brackets))
    .normalize('NFKC')
    .replace(/[\s\u200b\ufeff]/gu, '')
    .replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/。/gu, '.').replace(/、/gu, ',')
    .replace(/−/gu, '-').replace(/⁄/gu, '/');
}

// Keep the imported Flutter template as the historical baseline; apply the
// explicitly relaxed JS policy at request construction, including the cache key.
export function correctionPrompt(template) {
  return template
    .replace('【任务 A：纠正错别字（只允许改明显的听错，不许改写）】', '【任务 A：依据课件和上下文纠正听写错误】')
    .replace('   · ✅ **可以改**：明显的**谐音听错**、**错别字**。', '   · ✅ **可以改**：谐音听错、错别字、错误术语、数学公式与符号、变量下标。相信你的专业判断；有课件与上下文依据时，可以连续纠正多处 ASR 错误。')
    .replace('   · ⚠️ **硬约束**：改动的字数**不超过 30 字**，且**不超过原句字数的 50%**。\n     超过会被程序**拒绝并打回**，你还要重做一遍 —— 所以**只改你有把握的**。',
      `   · 纠错预算：排除空白、全半角、Unicode 上下标及等价标点等格式差异后，实质改动最多 ${correctionPolicy.maxEditDistance} 字，且不超过原句的 ${correctionPolicy.maxEditRatio * 100}%。格式变化本身不占预算，保留清晰的公式排版。\n     保留老师表达的意思、语气和句子对应关系；不要因为一条公式或多个术语需要连续修正而放弃纠错。没有依据的补充和整句另写仍不属于纠错。`);
}
