import { Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { geminiClient } from '../representation/representation-config';
import { UsageRecorder } from '../observability/usage-recorder';
import { SourcesModule } from '../sources/sources.module';
import { ANALYSIS_LLM, AnalysisPipeline } from './analysis-pipeline';
import { AnalysisRunner } from './analysis-runner';
import { AnalysisView } from './analysis-view';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { TasteModelScorer } from '../taste-models/taste-model.scorer';
import { PERSONAL_SCORER } from './personal-scorer';

/** The analysis pipeline and its endpoints (BE-8, spec 8, CONTRACT 4.4). */
@Module({
  imports: [SourcesModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    AnalysisPipeline,
    AnalysisRunner,
    AnalysisView,
    UsageRecorder,
    {
      provide: ANALYSIS_LLM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => geminiClient(config),
    },
    // The taste models (BE-13, D-024); MODEL_UNAVAILABLE until a release is loaded.
    { provide: PERSONAL_SCORER, useClass: TasteModelScorer },
  ],
  exports: [AnalysisRunner, AnalysisView],
})
export class AnalysisModule {}
