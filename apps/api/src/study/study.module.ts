import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module';
import { TasteModelScorer } from '../taste-models/taste-model.scorer';
import { StudyController } from './study.controller';
import { StudyService } from './study.service';

/** The user study of spec 9 (FE-10, D-027, CONTRACT 4.6). */
@Module({
  imports: [DiscoveryModule],
  controllers: [StudyController],
  providers: [StudyService, TasteModelScorer],
})
export class StudyModule {}
