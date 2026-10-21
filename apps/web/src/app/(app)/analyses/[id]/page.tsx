'use client';

import { useParams } from 'next/navigation';
import { AnalysisScreen } from '@/components/analysis/analysis-screen';

/** The result of one analysis (FE-5). Discovery (FE-4) opens it after starting the analysis. */
export default function AnalysisPage() {
  const { id } = useParams<{ id: string }>();
  // A new id starts from a clean screen rather than showing the previous result.
  return <AnalysisScreen key={id} id={id} />;
}
