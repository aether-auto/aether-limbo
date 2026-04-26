#!/bin/sh
trap 'echo CAUGHT_TERM; exit 0' TERM
trap 'echo CAUGHT_INT; exit 0' INT
i=0
while [ $i -lt 60 ]; do
  sleep 1
  i=$((i + 1))
done
