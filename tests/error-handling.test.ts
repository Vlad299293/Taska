import { ErrorHandler } from '../lib/errors/error-handler.js';
import { AppError, NetworkError, AuthError, ValidationError, SyncError } from '../lib/errors/app-error.js';
import { ErrorMapper } from '../lib/errors/error-mapper.js';

/**
 * Тесты системы обработки ошибок.
 */
export async function runErrorTests() {
  console.log('🚀 Starting Error Handling System Tests...');

  const testCases = [
    {
      name: 'Network Error mapping',
      error: new Error('Failed to fetch'),
      expectedCode: 'NETWORK_ERROR',
    },
    {
      name: 'Supabase RLS Error mapping',
      error: { code: '42501', message: 'Permission denied' },
      expectedCode: 'RLS_VIOLATION',
    },
    {
      name: 'Custom AppError preservation',
      error: new ValidationError('Wrong time block'),
      expectedCode: 'VALIDATION_ERROR',
    },
    {
      name: 'Generic error fallback',
      error: new Error('Something weird happened'),
      expectedCode: 'INTERNAL_ERROR',
    }
  ];

  let passed = 0;
  for (const tc of testCases) {
    const mapped = ErrorMapper.map(tc.error);
    if (mapped.code === tc.expectedCode) {
      console.log(`✅ ${tc.name}: PASSED`);
      passed++;
    } else {
      console.error(`❌ ${tc.name}: FAILED (Expected ${tc.expectedCode}, got ${mapped.code})`);
    }
  }

  console.log(`\nSummary: ${passed}/${testCases.length} tests passed.`);
  return passed === testCases.length;
}

runErrorTests().then(res => process.exit(res ? 0 : 1));
