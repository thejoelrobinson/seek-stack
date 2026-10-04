import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PurchaseStore} from '../lib/purchases.js';

test('purchase imports are searchable, idempotent, and keep review totals separate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-purchases-'));
  const store = await PurchaseStore.open(join(root, 'purchases.sqlite'));
  t.after(async () => { store.close(); await rm(root, {recursive:true, force:true}); });

  const batch = {batchId:'fixture-batch',results:[
    {status:'verified',verified:true,orderId:'W-100',sourceUrl:'https://www.walmart.com/orders/W-100',date:'2026-09-01',totalCents:1250,taxCents:100,associateDiscountCents:50,rows:[{name:'Storage bin',quantity:2,amountCents:1150}]},
    {status:'needs_review',verified:false,orderId:'W-101',sourceUrl:'https://www.walmart.com/orders/W-101',date:'2026-08-20',totalCents:999,issues:['receipt total did not reconcile'],rows:[{name:'Unknown item',quantity:1,amountCents:999}]},
    {status:'failed',sourceUrl:'https://www.walmart.com/orders/W-102'}
  ]};
  const first = store.importBatch('walmart',batch,{sourceKind:'fixture'});
  assert.deepEqual({received:first.received,saved:first.saved,verified:first.verified,needsReview:first.needsReview,failed:first.failed},
    {received:3,saved:2,verified:1,needsReview:1,failed:1});

  const matches = store.search({retailer:'walmart',query:'Storage bin'});
  assert.equal(matches.length,1);
  assert.equal(matches[0].total,'12.50');
  assert.equal(matches[0].amount,'11.50');
  assert.equal(matches[0].verification,'verified');

  const summary = store.summary({retailer:'walmart'}).byRetailer[0];
  assert.equal(summary.orders,2);
  assert.equal(summary.verifiedTotalCents,1250);
  assert.equal(summary.reviewTotalCents,999);
  assert.equal(summary.verified,1);
  assert.equal(summary.needsReview,1);

  const corrected = structuredClone(batch);
  corrected.results[0].totalCents=1300;
  corrected.results[0].rows[0].amountCents=1200;
  store.importBatch('walmart',corrected,{sourceKind:'fixture'});
  assert.equal(store.summary({retailer:'walmart'}).byRetailer[0].orders,2);
  assert.equal(store.search({retailer:'walmart',query:'Storage bin'})[0].total,'13.00');
});

test('normalized import contract supports another retailer without adapter-specific extraction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-purchases-adapter-'));
  const store = await PurchaseStore.open(join(root, 'purchases.sqlite'));
  t.after(async () => { store.close(); await rm(root, {recursive:true, force:true}); });
  const result = store.importBatch('home_depot', {batchId:'hd-fixture',results:[
    {status:'verified',verified:true,sourceUrl:'https://www.homedepot.com/myaccount/orders/HD-1',date:'2026-07-01',totalCents:4200,rows:[{description:'Paint roller',quantity:1,amountCents:4200}]}
  ]});
  assert.equal(result.retailer,'Home Depot');
  assert.equal(store.search({retailer:'home_depot',query:'roller'})[0].total,'42.00');
});
