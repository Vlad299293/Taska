import { dataService } from '../lib/data-service';
import { db } from '../lib/db-local';
import { supabase } from '../lib/supabase';
import { syncEngine } from '../lib/sync-engine';

async function runTest() {
  console.log('🚀 Starting Offline-Sync Verification Test...');

  try {
    // 1. Очистка перед тестом
    await db.tasks.clear();
    await db.sessions.clear();
    console.log('✅ Local DB cleared');

    // 2. Имитация создания задачи в ОФЛАЙНЕ
    console.log('\n--- Test 1: Create task offline ---');
    const testTask = {
      title: 'Test Offline Task',
      description: 'Should be synced to cloud',
      user_id: 'test-user-id',
      status: 'todo' as const,
    };

    const created = await dataService.createTask(testTask);
    const localVersion = await db.tasks.get(created.id);

    if (localVersion?.synced === 0) {
      console.log('✅ Task created locally with synced: 0');
    } else {
      throw new Error('Task should be unsynced initially');
    }

    // 3. Синхронизация (Push)
    console.log('\n--- Test 2: Synchronizing to Cloud ---');
    await syncEngine.synchronize();

    const syncedVersion = await db.tasks.get(created.id);
    if (syncedVersion?.synced === 1) {
      console.log('✅ Local status updated to synced: 1');
    } else {
      throw new Error('Task should be marked as synced after synchronization');
    }

    // 4. Проверка в Supabase
    const { data: cloudData } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', created.id)
      .single();

    if (cloudData && cloudData.title === 'Test Offline Task') {
      console.log('✅ Task found in Supabase cloud!');
    } else {
      throw new Error('Task not found in cloud or data mismatch');
    }

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ TEST FAILED:');
    console.error(error);
    process.exit(1);
  }
}

runTest();
