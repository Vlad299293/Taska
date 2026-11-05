import { localDb, LocalProfile } from './db-local';
import { ErrorHandler } from './errors/error-handler';

export type AuthMode = 'local' | 'guest';

interface AuthState {
  user: LocalProfile | null;
  mode: AuthMode;
}

class AuthService {
  private state: AuthState = {
    user: null,
    mode: 'guest',
  };

  async init() {
    try {
      // Инициализируем базу данных
      await localDb.init();
      
      // Проверяем, есть ли уже созданный профиль (в локальном приложении один основной профиль)
      const profiles = await localDb.query<LocalProfile>('SELECT * FROM local_profiles LIMIT 1');
      
      if (profiles && profiles.length > 0) {
        this.state = {
          user: profiles[0],
          mode: 'local',
        };
      } else {
        this.state = {
          user: null,
          mode: 'guest',
        };
      }
    } catch (e) {
      ErrorHandler.handle(e);
      this.state = { user: null, mode: 'guest' };
    }
  }

  async register(email: string, password: string, displayName: string) {
    try {
      // В локальной версии мы просто создаем профиль в SQLite
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      
      // В реальном приложении здесь должен быть хеш пароля (например, через bcrypt)
      // Для текущего этапа храним как есть, но в БД поле называется password_hash
      await localDb.execute(
        'INSERT INTO local_profiles (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, email, password, displayName, createdAt]
      );

      const newUser: LocalProfile = {
        id,
        email,
        password_hash: password,
        display_name: displayName,
        created_at: createdAt,
      };

      this.state = { user: newUser, mode: 'local' };
      return { mode: 'local', user: newUser };
    } catch (e) {
      ErrorHandler.handle(e);
      throw e;
    }
  }

  async login(email: string, password: string) {
    try {
      const profiles = await localDb.query<LocalProfile>(
        'SELECT * FROM local_profiles WHERE email = ? AND password_hash = ?',
        [email, password]
      );

      if (!profiles || profiles.length === 0) {
        throw new Error('Неверный email или пароль');
      }

      const user = profiles[0];
      this.state = { user, mode: 'local' };
      return { mode: 'local', user };
    } catch (e) {
      ErrorHandler.handle(e);
      throw e;
    }
  }

  async logout() {
    // В локальной версии выход просто сбрасывает состояние в памяти
    this.state = { user: null, mode: 'guest' };
  }

  getState() {
    return this.state;
  }
}

export const authService = new AuthService();
