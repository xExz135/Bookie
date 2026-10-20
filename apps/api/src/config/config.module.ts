import { type DynamicModule, Global, Inject, Module } from '@nestjs/common';
import type { AppConfig } from './app-config';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Injects the validated settings: `@InjectConfig() private readonly config: AppConfig`. */
export const InjectConfig = () => Inject(APP_CONFIG);

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
