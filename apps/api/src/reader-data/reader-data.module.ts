import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { AuthModule } from '../auth/auth.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { CompareService } from './compare.service';
import { FeedbackService } from './feedback.service';
import { MyDataService } from './my-data.service';
import {
  CompareController,
  FeedbackController,
  MyDataController,
  ReadingListController,
} from './reader-data.controller';
import { ReadingListService } from './reading-list.service';

/** The reader's own data beyond analyses: feedback, reading list, compare, delete (BE-10, CONTRACT 4.5). */
@Module({
  imports: [AnalysisModule, AuthModule, DiscoveryModule],
  controllers: [FeedbackController, ReadingListController, CompareController, MyDataController],
  providers: [FeedbackService, ReadingListService, CompareService, MyDataService],
})
export class ReaderDataModule {}
