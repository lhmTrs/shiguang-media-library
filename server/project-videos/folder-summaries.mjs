// Read-only metadata aggregation. Never asks the media/status layer to inspect files.
export function summarizeVideoFolders(rows, entries, rejectFolderId, isManaged) {
 const byId=new Map(rows.map(row=>[row.id,row]));
 const chains=new Map(),summaries=new Map(rows.map(row=>[row.id,{videoCount:0,covers:[]}]));
 for(const row of rows){
  const chain=[],seen=new Set();let current=row.id;
  while(byId.has(current)&&!seen.has(current)){
   seen.add(current);chain.push(current);current=byId.get(current).parentId;
  }
  chains.set(row.id,chain);
 }
 const rejected=id=>chains.get(id)?.includes(rejectFolderId)===true;
 const targets=id=>(chains.get(id)||[]).filter(parent=>!rejected(id)||rejected(parent));
 const unique=new Map();
 for(const entry of entries)if(!entry.data.removedAt&&!unique.has(entry.source.id))unique.set(entry.source.id,entry);
 const ordered=[...unique.values()].sort((a,b)=>b.source.created_at-a.source.created_at||(a.source.id<b.source.id?1:a.source.id>b.source.id?-1:0));
 for(const entry of ordered){
  const scope=targets(entry.folderId);
  for(const id of scope)summaries.get(id).videoCount++;
  const available=scope.filter(id=>summaries.get(id).covers.length<3);
  if(!available.length||!isManaged(entry))continue;
  const cover={videoId:entry.source.id,thumbnailUrl:`/api/media/${entry.data.mediaAssetId}/thumb`};
  for(const id of available)summaries.get(id).covers.push({...cover});
 }
 return summaries;
}
