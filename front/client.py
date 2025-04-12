from flask import Flask, render_template

app = Flask(__name__)

@app.route("/")
def index():
    return render_template("client.html")

@app.route("/v2")
def v2_index():
    return render_template("v2.client.html")

if __name__ == "__main__":
    app.run(debug=True)