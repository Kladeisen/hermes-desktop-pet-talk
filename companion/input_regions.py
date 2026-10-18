"""Closed, bounded presentation-only native hit regions in logical pixels."""
import math

def normalize_regions(rectangles, width=360, height=320):
    if not isinstance(rectangles,list) or len(rectangles)>8:
        return []
    result=[]
    for rect in rectangles:
        if not isinstance(rect,list) or len(rect)!=4 or any(type(v) not in (int,float) or not math.isfinite(v) for v in rect):
            return []
        left,top,w,h=rect
        if w<=0 or h<=0:
            continue
        right=min(width,math.ceil(left+w));bottom=min(height,math.ceil(top+h))
        left=max(0,math.floor(left));top=max(0,math.floor(top))
        if right>left and bottom>top:
            result.append((left,top,right-left,bottom-top))
    return result
