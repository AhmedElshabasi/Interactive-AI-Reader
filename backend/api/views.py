# backend/api/views.py
from django.http import JsonResponse, FileResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
import json
import os
import requests
import subprocess
import tempfile
import threading
import queue
import base64
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.parsers import JSONParser
from rest_framework import status

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@csrf_exempt
def chatgpt(request):
    if request.method == 'POST':
        try:
            data = json.loads(request.body)
            user_input = data.get('prompt', '')
            max_tokens = data.get('max_tokens', 1000)

            messages = [
                {
                    "role": "system",
                    "content": "You are an assistant that formats text for text-to-speech output."
                },
                {
                    "role": "user",
                    "content": user_input
                }
            ]

            response = requests.post(
                'https://api.openai.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {os.getenv("OPENAI_API_KEY")}',
                    'Content-Type': 'application/json'
                },
                json={
                    'model': 'gpt-4o',  # ← Use GPT-4o here
                    'messages': messages,
                    'max_tokens': max_tokens,
                    'temperature': 0.7
                }
            )

            return JsonResponse(response.json())

        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)

    return JsonResponse({'error': 'Only POST requests allowed'}, status=405)


# Helper function to generate audio from text using Piper TTS
def generate_audio_from_text(text, model_path=None, snippet_index=None):
    """Generate audio file from text using Piper TTS. Returns path to audio file."""
    import logging
    logger = logging.getLogger(__name__)
    
    snippet_info = f"[Snippet {snippet_index}]" if snippet_index is not None else "[Single]"
    text_preview = text[:50] + "..." if len(text) > 50 else text
    logger.info(f"{snippet_info} Starting audio generation for text: '{text_preview}'")
    print(f"{snippet_info} 🎤 Starting audio generation ({len(text)} chars)...")
    
    if model_path is None:
        model_path = os.getenv('PIPER_MODEL_PATH', os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            'voices',
            'en_US-ryan-high.onnx'
        ))
    
    # Handle relative paths and paths with spaces
    if not os.path.isabs(model_path):
        # Try relative to backend directory
        backend_dir = os.path.dirname(os.path.dirname(__file__))
        possible_path = os.path.join(backend_dir, model_path)
        if os.path.exists(possible_path):
            model_path = possible_path
        elif os.path.exists(model_path):
            model_path = os.path.abspath(model_path)
    
    # Verify model file exists
    if not os.path.exists(model_path):
        error_msg = f"{snippet_info} ❌ ERROR: Model file not found at: {model_path}"
        logger.error(error_msg)
        print(error_msg)
        raise FileNotFoundError(error_msg)
    
    logger.info(f"{snippet_info} Using model: {model_path}")
    print(f"{snippet_info} 📁 Model path: {model_path}")
    
    # Create temporary file for output
    with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as tmp_file:
        output_path = tmp_file.name
    
    logger.info(f"{snippet_info} Output file: {output_path}")
    print(f"{snippet_info} 💾 Creating audio file: {output_path}")
    
    try:
        # Use Piper TTS to generate speech
        logger.info(f"{snippet_info} Running Piper TTS command...")
        print(f"{snippet_info} ⚙️  Running Piper TTS (this may take a moment)...")
        
        process = subprocess.Popen(
            ['piper', '--model', model_path, '--output_file', output_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        stdout, stderr = process.communicate(input=text)
        
        if process.returncode != 0:
            error_msg = f"{snippet_info} ❌ Piper TTS failed with return code {process.returncode}"
            logger.error(f"{error_msg}: {stderr}")
            print(f"{error_msg}")
            print(f"{snippet_info} Error details: {stderr}")
            raise Exception(f'Piper TTS failed: {stderr}')
        
        # Check if file was created and has content
        if not os.path.exists(output_path):
            error_msg = f"{snippet_info} ❌ ERROR: Output file was not created"
            logger.error(error_msg)
            print(error_msg)
            raise Exception(error_msg)
        
        file_size = os.path.getsize(output_path)
        if file_size == 0:
            error_msg = f"{snippet_info} ❌ ERROR: Output file is empty"
            logger.error(error_msg)
            print(error_msg)
            raise Exception(error_msg)
        
        logger.info(f"{snippet_info} ✅ Audio file created successfully ({file_size} bytes)")
        print(f"{snippet_info} ✅ Audio file created! ({file_size} bytes)")
        
        return output_path
    except FileNotFoundError as e:
        if 'piper' in str(e).lower():
            error_msg = f"{snippet_info} ❌ ERROR: 'piper' command not found. Is piper-tts installed?"
            logger.error(error_msg)
            print(error_msg)
            raise Exception("Piper TTS command not found. Please ensure piper-tts is installed and 'piper' is in your PATH.")
        raise
    except Exception as e:
        error_msg = f"{snippet_info} ❌ ERROR during audio generation: {str(e)}"
        logger.error(error_msg)
        print(error_msg)
        # Clean up on error
        if os.path.exists(output_path):
            os.unlink(output_path)
        raise e

class TextToSpeechAPIView(APIView):
    parser_classes = [JSONParser]

    def post(self, request, *args, **kwargs):
        text = request.data.get('text')
        if not text:
            return Response({'error': 'No text provided.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Generate audio using helper function
            output_path = generate_audio_from_text(text)
            
            # Return the audio file
            file_handle = open(output_path, 'rb')
            response = FileResponse(file_handle, content_type='audio/wav')
            response['Content-Disposition'] = 'attachment; filename="output.wav"'
            
            return response
            
        except FileNotFoundError:
            return Response({
                'error': 'Piper TTS not found. Please ensure piper-tts is installed and piper command is in PATH.'
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        except Exception as e:
            return Response({
                'error': f'Text-to-speech generation failed: {str(e)}'
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class BatchTextToSpeechAPIView(APIView):
    """Batch TTS endpoint that processes multiple snippets in parallel and streams them."""
    parser_classes = [JSONParser]

    def post(self, request, *args, **kwargs):
        snippets = request.data.get('snippets', [])
        if not snippets or not isinstance(snippets, list):
            return Response({
                'error': 'Please provide a list of text snippets in the "snippets" field.'
            }, status=status.HTTP_400_BAD_REQUEST)
        
        # Stream audio chunks as they're ready
        def generate_audio_stream():
            model_path = os.getenv('PIPER_MODEL_PATH', os.path.join(
                os.path.dirname(os.path.dirname(__file__)),
                'voices',
                'en_US-ryan-high.onnx'
            ))
            
            # Queue to collect results in order
            result_queue = queue.Queue()
            completed_count = [0]  # Use list to allow modification in nested function
            error_occurred = [False]
            
            def process_snippet(index, text):
                """Process a single snippet and put result in queue."""
                import logging
                logger = logging.getLogger(__name__)
                
                try:
                    print(f"[Snippet {index}] 📝 Processing snippet {index + 1}/{len(snippets)}")
                    logger.info(f"[Snippet {index}] Starting processing")
                    
                    if not text or not text.strip():
                        error_msg = f"[Snippet {index}] ⚠️  Empty text, skipping"
                        print(error_msg)
                        logger.warning(error_msg)
                        result_queue.put({
                            'index': index,
                            'success': False,
                            'error': 'Empty text'
                        })
                        return
                    
                    print(f"[Snippet {index}] 🔄 Generating audio...")
                    audio_path = generate_audio_from_text(text, model_path, snippet_index=index)
                    
                    print(f"[Snippet {index}] 📖 Reading audio file...")
                    # Read audio file as base64
                    with open(audio_path, 'rb') as f:
                        audio_bytes = f.read()
                        audio_data = base64.b64encode(audio_bytes).decode('utf-8')
                    
                    print(f"[Snippet {index}] 🧹 Cleaning up temporary file...")
                    # Clean up temp file
                    os.unlink(audio_path)
                    
                    audio_size_kb = len(audio_bytes) / 1024
                    print(f"[Snippet {index}] ✅ Successfully processed! ({audio_size_kb:.2f} KB)")
                    logger.info(f"[Snippet {index}] Successfully processed, audio size: {audio_size_kb:.2f} KB")
                    
                    result_queue.put({
                        'index': index,
                        'success': True,
                        'audio': audio_data,
                        'text': text[:100] + '...' if len(text) > 100 else text  # Preview
                    })
                except Exception as e:
                    error_msg = f"[Snippet {index}] ❌ ERROR: {str(e)}"
                    print(error_msg)
                    logger.error(error_msg, exc_info=True)
                    result_queue.put({
                        'index': index,
                        'success': False,
                        'error': str(e)
                    })
                finally:
                    completed_count[0] += 1
                    print(f"[Snippet {index}] 📊 Completed. Total progress: {completed_count[0]}/{len(snippets)}")
            
            print(f"🚀 Starting batch TTS for {len(snippets)} snippets with 3 parallel workers")
            logger = logging.getLogger(__name__)
            logger.info(f"Starting batch TTS processing for {len(snippets)} snippets")
            
            # Start processing all snippets in parallel
            with ThreadPoolExecutor(max_workers=3) as executor:
                print(f"📋 Submitting {len(snippets)} snippets to thread pool...")
                futures = {
                    executor.submit(process_snippet, i, snippet): i 
                    for i, snippet in enumerate(snippets)
                }
                print(f"✅ All snippets submitted! Processing in parallel...")
            
            # Stream results as they complete
            results_received = {}
            next_index = 0
            
            # Send initial status
            print(f"📡 Sending start signal to client...")
            yield f"data: {json.dumps({'type': 'start', 'total': len(snippets)})}\n\n"
            
            while completed_count[0] < len(snippets) or next_index < len(snippets):
                try:
                    # Get next result from queue (with timeout)
                    result = result_queue.get(timeout=2)
                    results_received[result['index']] = result
                    print(f"📬 Received result for snippet {result['index']} (success: {result.get('success', False)})")
                    
                    # Send results in order as they become available
                    while next_index in results_received:
                        result = results_received[next_index]
                        if result.get('success'):
                            print(f"📤 Sending snippet {next_index} to client (audio size: {len(result.get('audio', ''))} chars)...")
                            yield f"data: {json.dumps(result)}\n\n"
                            print(f"✅ Snippet {next_index} sent successfully")
                        else:
                            print(f"⚠️  Snippet {next_index} failed: {result.get('error', 'Unknown error')}")
                            yield f"data: {json.dumps(result)}\n\n"
                        del results_received[next_index]
                        next_index += 1
                        
                except queue.Empty:
                    # Check if we're still processing or just waiting for queue
                    if completed_count[0] >= len(snippets) and next_index >= len(snippets):
                        break
                    if completed_count[0] < len(snippets):
                        print(f"⏳ Waiting for snippets... ({completed_count[0]}/{len(snippets)} completed, {next_index} sent)")
                    continue
            
            # Ensure all results are sent before completing
            print(f"🔄 Flushing remaining results... (sent {next_index}/{len(snippets)})")
            while next_index < len(snippets):
                if next_index in results_received:
                    result = results_received[next_index]
                    print(f"📤 Flushing snippet {next_index}...")
                    yield f"data: {json.dumps(result)}\n\n"
                    del results_received[next_index]
                    next_index += 1
                else:
                    print(f"⚠️  Missing snippet {next_index}, skipping...")
                    next_index += 1
            
            # Send completion status
            print(f"🎉 All snippets processed and sent! ({next_index} sent, {len(results_received)} remaining)")
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"
        
        response = StreamingHttpResponse(
            generate_audio_stream(),
            content_type='text/event-stream'
        )
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'
        return response


class StreamingTextToSpeechAPIView(APIView):
    """Streaming TTS endpoint for real-time continuous playback."""
    parser_classes = [JSONParser]

    def post(self, request, *args, **kwargs):
        snippets = request.data.get('snippets', [])
        if not snippets or not isinstance(snippets, list):
            return Response({
                'error': 'Please provide a list of text snippets in the "snippets" field.'
            }, status=status.HTTP_400_BAD_REQUEST)
        
        model_path = os.getenv('PIPER_MODEL_PATH', os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            'voices',
            'en_US-ryan-high.onnx'
        ))
        
        def stream_audio_chunks():
            """Generate audio chunks in order, starting generation in parallel."""
            executor = ThreadPoolExecutor(max_workers=3)
            futures = {}
            
            try:
                # Start generating first few snippets immediately
                for i in range(min(3, len(snippets))):
                    if snippets[i] and snippets[i].strip():
                        futures[i] = executor.submit(
                            generate_audio_from_text, 
                            snippets[i], 
                            model_path
                        )
                
                # Process snippets in order, generating ahead
                for i in range(len(snippets)):
                    # Start generation for next snippet if not already started
                    next_i = i + 3
                    if next_i < len(snippets) and snippets[next_i] and snippets[next_i].strip():
                        if next_i not in futures:
                            futures[next_i] = executor.submit(
                                generate_audio_from_text,
                                snippets[next_i],
                                model_path
                            )
                    
                    # Wait for current snippet's audio
                    if i in futures and snippets[i] and snippets[i].strip():
                        try:
                            audio_path = futures[i].result(timeout=30)
                            
                            # Send audio chunk
                            with open(audio_path, 'rb') as f:
                                audio_data = f.read()
                            
                            # Send metadata and audio
                            metadata = {
                                'index': i,
                                'total': len(snippets),
                                'size': len(audio_data)
                            }
                            yield f"data: {json.dumps(metadata)}\n\n".encode('utf-8')
                            yield audio_data
                            yield b"\n\n"  # Separator
                            
                            # Clean up
                            os.unlink(audio_path)
                            del futures[i]
                        except Exception as e:
                            error_data = {
                                'index': i,
                                'error': str(e)
                            }
                            yield f"data: {json.dumps(error_data)}\n\n".encode('utf-8')
                # Send completion
                yield f"data: {json.dumps({'type': 'complete'})}\n\n".encode('utf-8')
            finally:
                executor.shutdown(wait=False)
                # Clean up any remaining files
                for future in futures.values():
                    try:
                        if future.done():
                            audio_path = future.result()
                            if os.path.exists(audio_path):
                                os.unlink(audio_path)
                    except:
                        pass
        
        response = StreamingHttpResponse(
            stream_audio_chunks(),
            content_type='application/octet-stream'
        )
        response['Cache-Control'] = 'no-cache'
        response['X-Accel-Buffering'] = 'no'
        return response

