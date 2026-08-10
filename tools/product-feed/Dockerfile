FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml .
COPY src/ src/
RUN pip install --no-cache-dir -e .

COPY registry/ registry/

RUN mkdir -p /data

EXPOSE 4761

CMD ["python", "-m", "productfeed", "serve"]
