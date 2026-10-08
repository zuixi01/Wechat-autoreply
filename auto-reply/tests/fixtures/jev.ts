import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'

export const jevRequest: JevRequest = {
  model: 'jev-test',
  state: { message: '商品坏了，请找人工。' },
  questions: {
    intent: {
      type: 'choice',
      instructions: '判断客户主要诉求',
      criteria: { sale: '售前', support: '售后' }
    },
    human: { type: 'noul', instructions: '客户是否要求人工？' },
    urgency: { type: 'score', instructions: '紧急程度', criteria: ['低', '中', '高'] }
  }
}
export const jevResponse: JevResponse = {
  model: 'jev-test-resolved',
  answers: {
    intent: {
      type: 'choice',
      choice: 'support',
      confidence: 0.8,
      probabilities: { sale: 0.1, support: 0.9 }
    },
    human: { type: 'noul', noul: 0.98 },
    urgency: {
      type: 'score',
      score: 1.7,
      confidence: 0.7,
      legend: { '0': '低', '1': '中', '2': '高' },
      probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 }
    }
  },
  usage: { input_tokens: 180, output_tokens: 35 }
}
