export function assertApprovalBinding(approval,binding,{required=true}={}){
  if(!approval)throw new Error('This approval is no longer active.');
  const id=approval.proposalId||approval.id;
  if(required&&(!binding?.proposalId||approval.fingerprint&&!binding.fingerprint))throw new Error('Refresh this approval and review its current details.');
  if(binding?.proposalId&&binding.proposalId!==id||binding?.fingerprint&&binding.fingerprint!==approval.fingerprint)throw new Error('The reviewed action changed. Refresh and review the current proposal.');
}
