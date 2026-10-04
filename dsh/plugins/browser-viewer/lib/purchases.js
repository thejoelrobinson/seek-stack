import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';

export const PURCHASE_DB_PATH=join(process.env.DSH_WORK_HOME||join(homedir(),'.dsh','work'),'purchases.sqlite');
export const RETAILER_ADAPTERS=Object.freeze({
  walmart:{label:'Walmart',hosts:['walmart.com'],capture:'viewer_receipts'},
  // Retailer adapters share this normalized record contract. Add a DOM/API extractor
  // once a signed-in account page has been inspected; do not guess site selectors.
});

const cents=value=>Number.isSafeInteger(value)?value:null;
const isoDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;

export class PurchaseStore {
  constructor(path=PURCHASE_DB_PATH){this.path=path;this.db=new DatabaseSync(path);this.init();}
  static async open(path=PURCHASE_DB_PATH){await mkdir(dirname(path),{recursive:true});return new PurchaseStore(path);}
  init(){
    this.db.exec(`PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS retailers (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, adapter TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY, retailer_id TEXT NOT NULL REFERENCES retailers(id), external_order_id TEXT,
        source_url TEXT NOT NULL, order_date TEXT, currency TEXT NOT NULL DEFAULT 'USD',
        total_cents INTEGER, tax_cents INTEGER, discount_cents INTEGER, verification TEXT NOT NULL,
        source_kind TEXT NOT NULL, captured_at TEXT NOT NULL, issues_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(retailer_id,source_url)
      );
      CREATE INDEX IF NOT EXISTS purchase_orders_date ON purchase_orders(retailer_id,order_date);
      CREATE TABLE IF NOT EXISTS purchase_items (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        line_number INTEGER NOT NULL, description TEXT NOT NULL, quantity REAL, amount_cents INTEGER,
        UNIQUE(order_id,line_number)
      );
      CREATE INDEX IF NOT EXISTS purchase_items_description ON purchase_items(description);
      CREATE TABLE IF NOT EXISTS purchase_imports (
        id TEXT PRIMARY KEY, retailer_id TEXT NOT NULL REFERENCES retailers(id), source_kind TEXT NOT NULL,
        captured_at TEXT NOT NULL, received INTEGER NOT NULL, inserted_or_updated INTEGER NOT NULL,
        needs_review INTEGER NOT NULL, failed INTEGER NOT NULL
      );`);
  }
  importBatch(retailerId,batch,{sourceKind='browser_dom'}={}){
    if(!/^[a-z][a-z0-9_-]{1,40}$/.test(retailerId))throw new Error('Invalid retailer id.');
    if(!batch||!Array.isArray(batch.results))throw new Error('The import must contain a results array.');
    const adapter=RETAILER_ADAPTERS[retailerId];
    const label=adapter?.label||retailerId.replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const capturedAt=new Date().toISOString();
    const insertRetailer=this.db.prepare(`INSERT INTO retailers(id,label,adapter) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,adapter=excluded.adapter`);
    const upsertOrder=this.db.prepare(`INSERT INTO purchase_orders(retailer_id,external_order_id,source_url,order_date,currency,total_cents,tax_cents,discount_cents,verification,source_kind,captured_at,issues_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(retailer_id,source_url) DO UPDATE SET
      external_order_id=excluded.external_order_id,order_date=excluded.order_date,currency=excluded.currency,total_cents=excluded.total_cents,
      tax_cents=excluded.tax_cents,discount_cents=excluded.discount_cents,verification=excluded.verification,
      source_kind=excluded.source_kind,captured_at=excluded.captured_at,issues_json=excluded.issues_json`);
    const getOrder=this.db.prepare('SELECT id FROM purchase_orders WHERE retailer_id=? AND source_url=?');
    const clearItems=this.db.prepare('DELETE FROM purchase_items WHERE order_id=?');
    const addItem=this.db.prepare('INSERT INTO purchase_items(order_id,line_number,description,quantity,amount_cents) VALUES(?,?,?,?,?)');
    const addImport=this.db.prepare(`INSERT INTO purchase_imports(id,retailer_id,source_kind,captured_at,received,inserted_or_updated,needs_review,failed) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET retailer_id=excluded.retailer_id,source_kind=excluded.source_kind,captured_at=excluded.captured_at,
      received=excluded.received,inserted_or_updated=excluded.inserted_or_updated,needs_review=excluded.needs_review,failed=excluded.failed`);
    let saved=0,review=0,failed=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      insertRetailer.run(retailerId,label,adapter?.capture||'normalized_json');
      for(const r of batch.results){
        if(!r||r.status==='failed'||r.status==='not_started'){failed++;continue;}
        const sourceUrl=typeof r.sourceUrl==='string'?r.sourceUrl:typeof r.url==='string'?r.url:'';
        if(!sourceUrl){failed++;continue;}
        const status=r.status==='verified'&&r.verified!==false?'verified':'needs_review';
        const date=isoDate(r.date);
        upsertOrder.run(retailerId,String(r.orderId||'')||null,sourceUrl,date,
          typeof r.currency==='string'?r.currency:'USD',cents(r.totalCents),cents(r.taxCents),cents(r.associateDiscountCents),
          status,sourceKind,capturedAt,JSON.stringify(Array.isArray(r.issues)?r.issues:[]));
        const order=getOrder.get(retailerId,sourceUrl);clearItems.run(order.id);
        let line=0;
        for(const x of Array.isArray(r.rows)?r.rows:[]){
          const description=String(x.name??x.description??'').trim();if(!description)continue;
          const quantity=Number.isFinite(Number(x.quantity))?Number(x.quantity):null;
          addItem.run(order.id,line++,description,quantity,cents(x.amountCents));
        }
        if(status==='verified')saved++;else review++;
      }
      const id=String(batch.batchId||batch.id||`${retailerId}-${Date.now()}`);
      addImport.run(id,retailerId,sourceKind,capturedAt,batch.results.length,saved+review,review,failed);
      this.db.exec('COMMIT');
      return {retailer:label,batchId:id,received:batch.results.length,saved:saved+review,verified:saved,needsReview:review,failed,database:this.path};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  summary({retailer=null,since=null,until=null}={}){
    const where=[],params=[];
    if(retailer){where.push('retailer_id=?');params.push(retailer);}
    if(since){where.push('order_date>=?');params.push(since);}
    if(until){where.push('order_date<=?');params.push(until);}
    const filter=where.length?`WHERE ${where.join(' AND ')}`:'';
    return {byRetailer:this.db.prepare(`SELECT r.id retailer,r.label,COUNT(*) orders,
      SUM(CASE WHEN o.verification='verified' THEN COALESCE(o.total_cents,0) ELSE 0 END) verifiedTotalCents,
      SUM(CASE WHEN o.verification!='verified' THEN COALESCE(o.total_cents,0) ELSE 0 END) reviewTotalCents,
      SUM(CASE WHEN o.verification='verified' THEN 1 ELSE 0 END) verified,
      SUM(CASE WHEN o.verification!='verified' THEN 1 ELSE 0 END) needsReview
      FROM purchase_orders o JOIN retailers r ON r.id=o.retailer_id ${filter} GROUP BY r.id ORDER BY r.label`).all(...params),
      byMonth:this.db.prepare(`SELECT strftime('%Y-%m',order_date) month,retailer_id retailer,COUNT(*) orders,
      SUM(CASE WHEN verification='verified' THEN COALESCE(total_cents,0) ELSE 0 END) verifiedTotalCents,
      SUM(CASE WHEN verification!='verified' THEN COALESCE(total_cents,0) ELSE 0 END) reviewTotalCents
      FROM purchase_orders ${filter} GROUP BY month,retailer_id ORDER BY month,retailer_id`).all(...params),
      items:this.db.prepare(`SELECT COUNT(*) items FROM purchase_items i JOIN purchase_orders o ON o.id=i.order_id ${filter}`).get(...params).items,
      database:this.path};
  }
  search({retailer=null,query=null,since=null,until=null,limit=100}={}){
    const where=[],params=[];
    if(retailer){where.push('o.retailer_id=?');params.push(retailer);}
    if(since){where.push('o.order_date>=?');params.push(since);}
    if(until){where.push('o.order_date<=?');params.push(until);}
    if(query){where.push('(i.description LIKE ? OR o.external_order_id LIKE ?)');params.push(`%${query}%`,`%${query}%`);}
    const filter=where.length?`WHERE ${where.join(' AND ')}`:'';
    const rows=this.db.prepare(`SELECT r.label retailer,o.external_order_id orderId,o.order_date date,o.currency,o.total_cents totalCents,
      o.tax_cents taxCents,o.discount_cents discountCents,o.verification,i.description item,i.quantity,i.amount_cents amountCents,o.source_url sourceUrl
      FROM purchase_orders o JOIN retailers r ON r.id=o.retailer_id LEFT JOIN purchase_items i ON i.order_id=o.id ${filter}
      ORDER BY o.order_date DESC,o.id DESC,i.line_number LIMIT ?`).all(...params,Math.max(1,Math.min(500,Number(limit)||100)));
    return rows.map(r=>({...r,total:r.totalCents==null?null:(r.totalCents/100).toFixed(2),amount:r.amountCents==null?null:(r.amountCents/100).toFixed(2)}));
  }
  close(){this.db.close();}
}
