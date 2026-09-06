import { randomUUID } from "node:crypto";
import {
  ResilientEmbeddingPipeline,
  ResilientRerankPipeline,
  type RerankCandidate,
} from "./resilient-inference-pipeline";
import { DocumentIoManager, type ParsedDocument } from "./document-io-manager";

export interface KnowledgeDocument {
  id: string;
  companyId: string;
  title: string;
  content: string;
  format: ParsedDocument["format"];
  tags: string[];
  embeddingVector?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSearchResultItem {
  id: string;
  title: string;
  content: string;
  similarityScore: number;
  rerankScore?: number;
  finalRank: number;
  tags: string[];
}

export interface KnowledgeSearchResult {
  query: string;
  results: KnowledgeSearchResultItem[];
  rerankApplied: boolean;
  totalFound: number;
}

export class CompanyKnowledgeHub {
  private readonly documents = new Map<string, KnowledgeDocument>();

  /**
   * 1. Ingest document, extract text, and compute embeddings
   */
  async ingestDocument(params: {
    companyId: string;
    title: string;
    rawContent: string | Buffer;
    filename?: string;
    tags?: string[];
  }): Promise<KnowledgeDocument> {
    const filename = params.filename || `${params.title}.txt`;
    const parsed = DocumentIoManager.parseDocument(params.rawContent, filename);

    // Compute embedding vector
    const embResult = await ResilientEmbeddingPipeline.generateEmbeddings({
      texts: [parsed.text],
      dimensions: 128,
    });

    const id = `kdoc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const doc: KnowledgeDocument = {
      id,
      companyId: params.companyId,
      title: params.title,
      content: parsed.text,
      format: parsed.format,
      tags: params.tags ?? [],
      embeddingVector: embResult.vectors[0],
      createdAt: now,
      updatedAt: now,
    };

    this.documents.set(id, doc);
    return doc;
  }

  /**
   * 2. Search knowledge: Hybrid vector cosine search + Cross-Encoder Rerank
   */
  async searchKnowledge(params: {
    companyId: string;
    query: string;
    limit?: number;
    useRerank?: boolean;
    minScore?: number;
  }): Promise<KnowledgeSearchResult> {
    const limit = params.limit ?? 5;
    const useRerank = params.useRerank ?? true;
    const minScore = params.minScore ?? 0.2;

    const companyDocs = Array.from(this.documents.values()).filter(
      (d) => d.companyId === params.companyId
    );

    if (companyDocs.length === 0) {
      return { query: params.query, results: [], rerankApplied: false, totalFound: 0 };
    }

    // Compute query embedding
    const qEmb = await ResilientEmbeddingPipeline.generateEmbeddings({
      texts: [params.query],
      dimensions: 128,
    });
    const qVec = qEmb.vectors[0]!;

    // Calculate Cosine Similarity
    const scoredDocs = companyDocs.map((doc) => {
      let sim = 0.5;
      if (doc.embeddingVector) {
        sim = this.cosineSimilarity(qVec, doc.embeddingVector);
      }
      return { doc, sim };
    });

    // Sort by vector similarity
    scoredDocs.sort((a, b) => b.sim - a.sim);

    // Take candidates for Cross-Encoder Reranking
    const topCandidates = scoredDocs.slice(0, Math.max(limit * 2, 10));

    if (!useRerank) {
      const results: KnowledgeSearchResultItem[] = topCandidates.slice(0, limit).map((c, i) => ({
        id: c.doc.id,
        title: c.doc.title,
        content: c.doc.content,
        similarityScore: c.sim,
        finalRank: i + 1,
        tags: c.doc.tags,
      }));

      return {
        query: params.query,
        results,
        rerankApplied: false,
        totalFound: results.length,
      };
    }

    // Apply Cross-Encoder Rerank
    const rerankCandidates: RerankCandidate[] = topCandidates.map((c) => ({
      id: c.doc.id,
      text: `${c.doc.title}\n${c.doc.content}`,
      metadata: { doc: c.doc, baseSim: c.sim },
    }));

    const reranked = await ResilientRerankPipeline.rerank(params.query, rerankCandidates, {
      topK: limit,
      minScore,
    });

    const results: KnowledgeSearchResultItem[] = reranked.items.map((item) => {
      const doc = (item.metadata?.doc as KnowledgeDocument) || companyDocs.find((d) => d.id === item.id)!;
      const baseSim = (item.metadata?.baseSim as number) || 0.5;

      return {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        similarityScore: baseSim,
        rerankScore: item.relevanceScore,
        finalRank: item.rank,
        tags: doc.tags,
      };
    });

    return {
      query: params.query,
      results,
      rerankApplied: true,
      totalFound: results.length,
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return Number((dot / denom).toFixed(6));
  }
}
