const formatters=new Map();
function formatter(zone){if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}));return formatters.get(zone);}
export function normalizeSchedule(value){
  if(value==null)return null;
  if(value.kind!=='calendar'||!['daily','weekly'].includes(value.frequency)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time||''))throw new Error('Choose a daily or weekly schedule and a valid time.');
  const timeZone=value.timeZone||'America/Chicago';try{formatter(timeZone).format(0);}catch{throw new Error('Choose a valid IANA time zone.');}
  const weekdays=[...new Set(value.weekdays||[1])];if(value.frequency==='weekly'&&(!weekdays.length||weekdays.some(x=>!Number.isInteger(x)||x<0||x>6)))throw new Error('Choose weekdays from Sunday (0) to Saturday (6).');
  const missedRun=value.missedRun||'latest';if(!['latest','skip'].includes(missedRun))throw new Error('Invalid missed-run policy.');
  return {kind:'calendar',frequency:value.frequency,time:value.time,timeZone,weekdays,missedRun};
}
export function calendarParts(at,timeZone){const p=Object.fromEntries(formatter(timeZone).formatToParts(at).map(x=>[x.type,x.value]));return {date:p.year+'-'+p.month+'-'+p.day,time:p.hour+':'+p.minute,weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday)};}
export function nextCalendarRun(input,after=Date.now(),lastDate=null){
  const s=normalizeSchedule(input),start=Math.floor(after/60000)*60000+60000;
  // Search real UTC minutes: missing DST times skip; duplicate wall times run once per date.
  for(let at=start;at<=start+9*86400000;at+=60000){const p=calendarParts(at,s.timeZone);if(p.date!==lastDate&&p.time===s.time&&(s.frequency==='daily'||s.weekdays.includes(p.weekday)))return at;}
  throw new Error('Could not resolve the next calendar occurrence.');
}
export function scheduleKey(schedule,at){return calendarParts(at,schedule.timeZone).date+'@'+schedule.time+'['+schedule.timeZone+']';}
