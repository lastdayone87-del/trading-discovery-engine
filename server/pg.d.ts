declare module 'pg' {
  export class Pool {
    constructor(config?: any);
    query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
  export interface PoolClient {
    query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
    release(): void;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
