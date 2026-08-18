export interface CacheEntry<V> {
    value: V;
    expiresAt: number | null;
    groupKey: string | null;
    lastAccessed: number;
    accessCount: number;
}

export class BoundedCache<V> {
    private cache: Map<string, CacheEntry<V>> = new Map();
    private groupIndex: Map<string, Set<string>> = new Map();

    constructor(private readonly maxSize: number) {
        if (maxSize < 1) {
            throw new Error('maxSize must be atleast 1');

        }
    }
    get(key: string): V | undefined {
        const entry=this.cache.get(key);
        const now=Date.now()
        if(!entry){
            return undefined;
        }

        if(entry.expiresAt !== null && now>entry.expiresAt){
            this.deleteEntry(key,entry);
            return undefined
        }
        entry.lastAccessed=now;
        entry.accessCount++;
        return entry.value;

    }
    set(key: string, value: V, options?: { ttlMs?: number | null; groupKey?: string | null; }): void {
        const now=Date.now()
        const TtlMs=options?.ttlMs??null;
        const groupKey=options?.groupKey ?? null
        const existing = this.cache.get(key)
        if (existing) {
            this.deleteEntry(key, existing);
        }

        while(this.cache.size>=this.maxSize){
            this.evictLeastUsed();
        }

        const entry:CacheEntry<V>={
            value,
            expiresAt:TtlMs !== null? now +TtlMs:null,
            lastAccessed:now,
            accessCount:1,
            groupKey

        }
        this.cache.set(key,entry);

        if (groupKey!==null){
            let keys=this.groupIndex.get(groupKey)
            if(!keys){
                keys=new Set();
                this.groupIndex.set(groupKey,keys)
            }
            keys.add(key);
        }

    }

    private evictLeastUsed():void{
        let lowestScore=Infinity
        let  evictKey:string|null=null;
        const now=Date.now()
        for (const [key,entry] of this.cache){
            if(entry.expiresAt !=null && now>entry.expiresAt){
                this.deleteEntry(key,entry);
                return;
            }

            const ageSeconds=Math.max(1,(now-entry.lastAccessed)/1000)
            const score=entry.lastAccessed/ageSeconds;

            if (score<lowestScore){
                lowestScore=score;
                evictKey=key;
            }
        }

        if(evictKey!==null){
            const entry=this.cache.get(evictKey)
            if(entry){
                this.deleteEntry(evictKey,entry)
            }
        }


    }

    private deleteEntry(key: string, entry: CacheEntry<V>): void {
        this.cache.delete(key);

        if (entry.groupKey !== null) {
            const keys = this.groupIndex.get(entry.groupKey)

            if (keys) {
                keys.delete(key);
                if (keys.size === 0) {
                    this.groupIndex.delete(entry.groupKey)
                }
            }
        }
    }


}