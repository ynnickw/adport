/** Only identifiers and explicit per-source states may leave an error receipt. */
export const OPERATION_RECONCILIATION_UI = String.raw`
    function reconciliationOf(data,tool,args,applied=false) {
      const details=object(data?.details)?data.details:null;
      if(!details) return null;
      const result={},validId=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value);
      const reported=arr(details.resource_ids || details.resourceIds).filter(validId),ids=[...new Set(reported)];
      if(ids.length) result.resource_ids=ids.slice(0,100);
      if(ids.length>100) {result.resource_ids_truncated=true;result.total_resource_ids=ids.length;}
      if(tool==='x_create_repost_promotions') {
        const postId=value=>typeof value==='string' && /^[1-9][0-9]{0,24}$/.test(value),associationId=value=>typeof value==='string' && /^[a-z0-9]{1,32}$/.test(value),selected=new Set(arr(args?.tweet_ids).filter(postId));
        const sourceIds=value=>[...new Set(arr(value).filter(id=>postId(id) && selected.has(id)))].slice(0,50);
        const ambiguous=sourceIds(details.ambiguous_source_ids),ambiguousSet=new Set(ambiguous),confirmed=[],seen=new Set();
        for(const row of arr(applied?details.source_copy_mappings:details.confirmed_source_copy_mappings)) {
          if(!object(row) || !selected.has(row.source_tweet_id) || ambiguousSet.has(row.source_tweet_id) || !postId(row.copied_tweet_id) || selected.has(row.copied_tweet_id) || !associationId(row.promoted_tweet_id) || seen.has(row.source_tweet_id)) continue;
          seen.add(row.source_tweet_id);confirmed.push({source_tweet_id:row.source_tweet_id,copied_tweet_id:row.copied_tweet_id,promoted_tweet_id:row.promoted_tweet_id});
          if(confirmed.length===50) break;
        }
        if(confirmed.length) result[applied?'source_copy_mappings':'confirmed_source_copy_mappings']=confirmed;
        if(ambiguous.length) result.ambiguous_source_ids=ambiguous;
        const observed=[...new Set(arr(details.reported_tweet_ids).filter(postId))].slice(0,100),unattempted=sourceIds(details.unattempted_source_ids),outcomes=arr(details.source_outcomes).filter(row=>object(row) && selected.has(row.source_tweet_id) && ['UNCONFIRMED','NOT_STARTED'].includes(row.state)).slice(0,50).map(row=>({source_tweet_id:row.source_tweet_id,state:row.state}));
        if(observed.length) result.reported_tweet_ids=observed;
        if(unattempted.length) result.unattempted_source_ids=unattempted;
        if(outcomes.length) result.source_outcomes=outcomes;
        const next=details.next_arguments;
        if(applied && details.next_tool==='x_promoted_posts' && object(next) && next.account_id===args?.account_id && next.line_item_id===args?.line_item_id && postId(next.user_id) && next.user_id!==args?.user_id) result.next_arguments={...(typeof args.project_id==='string'?{project_id:args.project_id}:{}),account_id:args.account_id,line_item_id:args.line_item_id,user_id:next.user_id};
      }
      return Object.keys(result).length?result:null;
    }
`;
