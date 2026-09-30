// Budget labels are deliberately separate from Plaid's original classification.
export const BUDGET_CATEGORIES={HOUSING:'Housing',UTILITIES:'Utilities',GROCERIES:'Groceries',DINING:'Dining',MIXED_RETAIL:'Mixed retail',SHOPPING:'Shopping',TRANSPORTATION:'Transportation',HEALTH:'Health',HOME:'Home',PERSONAL_CARE:'Personal care',ENTERTAINMENT:'Entertainment',TRAVEL:'Travel',SUBSCRIPTIONS:'Subscriptions',EDUCATION:'Education',KIDS_FAMILY:'Kids & family',PETS:'Pets',GIFTS_GIVING:'Gifts & giving',FEES_TAXES:'Fees & taxes',INSURANCE:'Insurance',OTHER:'Other'};
export const mixedRetail=t=>/^(walmart|target|amazon|amazon\.com|costco|sam'?s club)$/i.test(String(t.merchant||t.name||'').trim())&&!/GROCER/.test(String(t.detail||'').toUpperCase());
export function budgetGuardrail(t){const merchant=String(t.merchant||t.name||'').trim().toLowerCase();if(mixedRetail(t))return 'MIXED_RETAIL';if(/^(amazon prime|walmart\+)$/.test(merchant))return 'SUBSCRIPTIONS';if(merchant==='amazon kindle')return 'ENTERTAINMENT';if(merchant==='mister sparky')return 'HOME';return null;}

export function budgetFallback(t){
  const primary=String(t.category||'').toUpperCase(),detail=String(t.detail||'').toUpperCase();
  const merchant=String(t.merchant||t.name||'').toLowerCase();
  if(/PET|VETERINARY/.test(detail))return 'PETS';
  if(/GROCERY|SUPERMARKET/.test(detail))return 'GROCERIES';
  if(budgetGuardrail(t))return budgetGuardrail(t);
  if(/RESTAURANT|FAST_FOOD|COFFEE|BAR|BAKERY/.test(detail))return 'DINING';
  if(/RENT|MORTGAGE/.test(detail))return 'HOUSING';
  if(/UTILIT|INTERNET|CABLE|PHONE/.test(detail))return 'UTILITIES';
  if(/INSURANCE/.test(detail))return 'INSURANCE';
  if(/SUBSCRIPTION|STREAMING/.test(detail))return 'SUBSCRIPTIONS';
  if(/PHARMACY|DOCTOR|DENTAL|HEALTH|MEDICAL|HOSPITAL/.test(detail))return 'HEALTH';
  if(/CHILD|DAYCARE/.test(detail))return 'KIDS_FAMILY';
  if(/EDUCATION|TUITION|SCHOOL/.test(detail))return 'EDUCATION';
  if(/DONATION|CHARIT/.test(detail))return 'GIFTS_GIVING';
  if(/TAX|BANK_FEE|FINANCE_CHARGE|OVERDRAFT|ATM_FEE/.test(detail))return 'FEES_TAXES';
  if(/HOME_IMPROVEMENT|HOME_REPAIR|FURNITURE/.test(detail))return 'HOME';
  if(/PERSONAL_CARE/.test(primary+' '+detail))return 'PERSONAL_CARE';
  if(/TRAVEL/.test(primary))return 'TRAVEL';
  if(/TRANSPORTATION|AUTO_AND_TRANSPORT/.test(primary))return 'TRANSPORTATION';
  if(/ENTERTAINMENT|RECREATION/.test(primary))return 'ENTERTAINMENT';
  if(/RENT_AND_UTILITIES/.test(primary))return 'UTILITIES';
  if(/FOOD_AND_DRINK/.test(primary))return /whole foods|trader joe|aldi|kroger|safeway|publix|heb|h-e-b|wegmans|meijer|walmart grocery|instacart/.test(merchant)?'GROCERIES':'DINING';
  if(/GENERAL_MERCHANDISE|GENERAL_SERVICES/.test(primary))return 'SHOPPING';
  if(/MEDICAL/.test(primary))return 'HEALTH';
  return 'OTHER';
}
