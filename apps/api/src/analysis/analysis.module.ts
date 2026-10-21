import { Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { geminiClient } from '../representation/representation-config';
import { SourcesModule } from '../sources/sources.module';
import { ANALYSIS_LLM, AnalysisPipeline } from './analysis-pipeline';
import { AnalysisRunner } from './analysis-runner';
import { AnalysisView } from './analysis-view';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { NoModelScorer, PERSONAL_SCORER } from './personal-scorer';

/** The analysis pipeline and its endpoints (BE-8, spec 8, CONTRACT 4.4). */
@Module({
  imports: [SourcesModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    AnalysisPipeline,
    AnalysisRunner,
    AnalysisView,
    {
      provide: ANALYSIS_LLM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => geminiClient(config),
    },
    { provide: PERSONAL_SCORER, useClass: NoModelScorer },
  ],
  exports: [AnalysisRunner, AnalysisView],
})
export class AnalysisModule {}
