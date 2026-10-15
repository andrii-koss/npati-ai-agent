export interface CodeMetricsSchema {
    title: string;
    subtitle: string;
    loading: string;
    empty: string;
    /** The word the panel puts in front of a metric's reason when nothing could be measured. */
    unavailable: string;
    successRate: string;
    avgTurns: string;
    failedEditRate: string;
    approvalsShare: string;
    toolErrorRate: string;
    costPerRun: string;
    sampleRuns: string;
    sampleSize: string;
    sampleWindow: string;
    sampleTruncated: string;
    estimated: string;
};